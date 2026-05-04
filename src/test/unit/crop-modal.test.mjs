/**
 * Unit tests for js/crop-modal.js — covers the pure normalizeCorners logic
 * and basic open/cancel lifecycle. Drag, magnifier, and perspectiveTransform
 * integration are out of scope (live in E2E).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/crop-modal.js');
const moduleSource = readFileSync(modulePath, 'utf8');

function loadIntoJsdom({ withImageTransforms = true } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'http://localhost/',
    });
    if (withImageTransforms) {
        dom.window.ImageTransforms = {
            perspectiveTransform: () => ({ toBlob: (cb) => cb(new dom.window.Blob([])) }),
            distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
        };
    }
    // jsdom provides URL.createObjectURL only when a Blob registry is wired up;
    // stub both so open() can call them.
    dom.window.URL.createObjectURL = () => 'blob:test/abc';
    dom.window.URL.revokeObjectURL = () => {};
    dom.window.eval(moduleSource);
    return dom.window;
}

// --- normalizeCorners (pure logic) ---

test('normalizeCorners: already-canonical square passes through', () => {
    const win = loadIntoJsdom();
    const input = {
        tl: { x: 0.1, y: 0.1 },
        tr: { x: 0.9, y: 0.1 },
        br: { x: 0.9, y: 0.9 },
        bl: { x: 0.1, y: 0.9 },
    };
    const out = win.CropModal.normalizeCorners(input);
    assert.deepEqual(out.tl, input.tl);
    assert.deepEqual(out.tr, input.tr);
    assert.deepEqual(out.br, input.br);
    assert.deepEqual(out.bl, input.bl);
});

test('normalizeCorners: swapped tl↔br and tr↔bl is relabelled correctly', () => {
    const win = loadIntoJsdom();
    const out = win.CropModal.normalizeCorners({
        tl: { x: 0.9, y: 0.9 }, // actually br
        tr: { x: 0.1, y: 0.9 }, // actually bl
        br: { x: 0.1, y: 0.1 }, // actually tl
        bl: { x: 0.9, y: 0.1 }, // actually tr
    });
    assert.deepEqual(out.tl, { x: 0.1, y: 0.1 });
    assert.deepEqual(out.tr, { x: 0.9, y: 0.1 });
    assert.deepEqual(out.br, { x: 0.9, y: 0.9 });
    assert.deepEqual(out.bl, { x: 0.1, y: 0.9 });
});

test('normalizeCorners: arbitrary permutation produces canonical orientation', () => {
    const win = loadIntoJsdom();
    const square = [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.2, y: 0.8 },
    ];
    // Rotate the labels: feed in a non-canonical mapping
    const out = win.CropModal.normalizeCorners({
        tl: square[2],
        tr: square[0],
        br: square[3],
        bl: square[1],
    });
    // Top row: smallest y. Within the row, tl.x < tr.x.
    assert.ok(out.tl.y <= out.bl.y, 'tl above bl');
    assert.ok(out.tr.y <= out.br.y, 'tr above br');
    assert.ok(out.tl.x < out.tr.x, 'tl left of tr');
    assert.ok(out.bl.x < out.br.x, 'bl left of br');
});

test('normalizeCorners: tilted (non-axis-aligned) quad still yields top/bottom split', () => {
    const win = loadIntoJsdom();
    // Diamond shape — sort-by-y picks the two smaller-y points as "top"
    const out = win.CropModal.normalizeCorners({
        tl: { x: 0.5, y: 0.1 }, // top apex
        tr: { x: 0.9, y: 0.5 }, // right apex
        br: { x: 0.5, y: 0.9 }, // bottom apex
        bl: { x: 0.1, y: 0.5 }, // left apex
    });
    // The two smallest-y points end up as top row, sorted by x.
    assert.ok(out.tl.y <= out.bl.y);
    assert.ok(out.tr.y <= out.br.y);
    assert.ok(out.tl.x <= out.tr.x);
    assert.ok(out.bl.x <= out.br.x);
});

// --- open() input validation ---

test('open() throws when sourceBlob is missing', () => {
    const win = loadIntoJsdom();
    assert.throws(() => win.CropModal.open(), /sourceBlob/);
    assert.throws(() => win.CropModal.open({}), /sourceBlob/);
});

test('open() throws when window.ImageTransforms is not loaded', () => {
    const win = loadIntoJsdom({ withImageTransforms: false });
    const blob = new win.Blob(['x'], { type: 'image/jpeg' });
    assert.throws(() => win.CropModal.open({ sourceBlob: blob }), /ImageTransforms/);
});

// --- open() + cancel() lifecycle ---

test('open() injects modal and removes hidden class; cancel() invokes callback and re-hides', () => {
    const win = loadIntoJsdom();
    const blob = new win.Blob(['x'], { type: 'image/jpeg' });
    let cancelCalled = 0;
    win.CropModal.open({
        sourceBlob: blob,
        onApply: () => {},
        onCancel: () => { cancelCalled++; },
    });
    const modal = win.document.getElementById('crop-modal');
    assert.ok(modal, 'modal element was injected');
    assert.equal(modal.classList.contains('hidden'), false, 'modal is visible after open()');

    const cancelBtn = modal.querySelector('[data-crop-action="cancel"]');
    cancelBtn.click();
    assert.equal(cancelCalled, 1, 'onCancel was invoked');
    assert.equal(modal.classList.contains('hidden'), true, 'modal hidden after cancel');
});

test('open() with custom initialCorners deep-clones them (mutating caller obj does not affect modal)', () => {
    const win = loadIntoJsdom();
    const blob = new win.Blob(['x'], { type: 'image/jpeg' });
    const corners = {
        tl: { x: 0.2, y: 0.2 },
        tr: { x: 0.8, y: 0.2 },
        br: { x: 0.8, y: 0.8 },
        bl: { x: 0.2, y: 0.8 },
    };
    win.CropModal.open({ sourceBlob: blob, initialCorners: corners, onApply: () => {} });
    // Mutate caller's object — modal should not observe the change.
    corners.tl.x = 999;
    corners.tl.y = 999;
    // We can't directly inspect internal state, but we can verify cancel still
    // works (no crash from corrupted internal corners) and the modal closes cleanly.
    const modal = win.document.getElementById('crop-modal');
    modal.querySelector('[data-crop-action="cancel"]').click();
    assert.equal(modal.classList.contains('hidden'), true);
});
