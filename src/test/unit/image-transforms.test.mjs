import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { makeGradientImageData, makeImageData } from '../support/canvas-shim.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/image-transforms.js');

// image-transforms.js uses document.createElement for canvas; stub it
const stubDocument = {
    createElement(tag) {
        if (tag !== 'canvas') throw new Error(`Unexpected createElement('${tag}')`);
        // Return a minimal canvas-like object backed by ImageData stubs.
        // perspectiveTransform is tested below only via the module-level functions
        // that don't need a full DOM canvas (applyOtsu, distance).
        // Full perspectiveTransform needs a real canvas — see E2E tests.
        const self = {
            width: 0,
            height: 0,
            _data: null,
            getContext(type) {
                return {
                    drawImage(img) { /* no-op for non-canvas inputs */ },
                    getImageData(x, y, w, h) {
                        const buf = new Uint8ClampedArray(w * h * 4);
                        return { data: buf, width: w, height: h };
                    },
                    createImageData(w, h) {
                        const buf = new Uint8ClampedArray(w * h * 4);
                        return { data: buf, width: w, height: h };
                    },
                    putImageData() {},
                };
            },
        };
        return self;
    },
};

const win = await loadBrowserModule(modulePath, { document: stubDocument });
const { applyOtsu, perspectiveTransform, distance,
        rotateImage, flipImage, binarize, cropPerspective,
        CROP_MAX_DIM, MAX_TRANSFORM_PIXELS } = win.ImageTransforms;

// ---- applyOtsu ----


test('applyOtsu: pure-white image stays white', () => {
    const img = makeImageData(10, 10);
    for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = 255;
    }
    applyOtsu(img);
    for (let i = 0; i < img.data.length; i += 4) {
        assert.ok(img.data[i] > 127, `Expected bright pixel at ${i}, got ${img.data[i]}`);
    }
});

test('applyOtsu: gradient image — left side darker than right side after binarization', () => {
    const W = 100, H = 10;
    const img = makeGradientImageData(W, H);
    applyOtsu(img);
    // Left-most pixel should be dark (value near 0)
    assert.ok(img.data[0] < 128, `Left pixel expected dark, got ${img.data[0]}`);
    // Right-most pixel should be bright
    const rightIdx = (H - 1) * W * 4 + (W - 1) * 4;
    assert.ok(img.data[rightIdx] > 127, `Right pixel expected bright, got ${img.data[rightIdx]}`);
});

test('applyOtsu: modifies in place (returns undefined)', () => {
    const img = makeImageData(4, 4);
    const result = applyOtsu(img);
    assert.equal(result, undefined);
});

// ---- distance ----

test('distance: zero for same point', () => {
    assert.equal(distance({ x: 5, y: 5 }, { x: 5, y: 5 }), 0);
});

test('distance: 5 for 3-4-5 right triangle', () => {
    const d = distance({ x: 0, y: 0 }, { x: 3, y: 4 });
    assert.ok(Math.abs(d - 5) < 1e-9, `Expected 5, got ${d}`);
});

test('distance: symmetric', () => {
    const a = { x: 1, y: 2 }, b = { x: 4, y: 6 };
    assert.equal(distance(a, b), distance(b, a));
});

// ---- new pipeline helpers: API-shape only ----
// Deeper behavioral tests need a real canvas + createImageBitmap + Blob; covered by E2E.

test('rotateImage / flipImage / binarize / cropPerspective are exported as functions', () => {
    assert.equal(typeof rotateImage, 'function');
    assert.equal(typeof flipImage, 'function');
    assert.equal(typeof binarize, 'function');
    assert.equal(typeof cropPerspective, 'function');
});

test('CROP_MAX_DIM is exported as a sensible defensive ceiling', () => {
    assert.equal(typeof CROP_MAX_DIM, 'number');
    // Big enough to fit a 4K-class crop, small enough to bound a worst-case
    // peer-driven createImageData allocation (8192*8192*4 = 256 MiB).
    assert.ok(CROP_MAX_DIM >= 4096 && CROP_MAX_DIM <= 16384);
});

test('MAX_TRANSFORM_PIXELS bounds the rotate/flip/binarize canvas allocation', () => {
    // 4 bytes per pixel on the receiver canvas; the cap should bound the
    // worst-case allocation to a single-digit-GB or less. 150 MP * 4 B/px
    // ~= 600 MB which is well under the multi-GB OOM threshold for the
    // receiver tab. The cap also must be above any legitimate stills
    // camera output (Phase One IQ4 ~150 MP is the upper bound of
    // legitimate medium-format sensors).
    assert.equal(typeof MAX_TRANSFORM_PIXELS, 'number');
    assert.ok(MAX_TRANSFORM_PIXELS >= 50 * 1024 * 1024);
    assert.ok(MAX_TRANSFORM_PIXELS <= 500 * 1024 * 1024);
});

// Drive rotateImage through a stubbed createImageBitmap so we can verify
// the dimension gate triggers on a pathological peer-supplied bitmap.
// We swap the global before each invocation so the module's reference
// to `createImageBitmap` resolves to our stub.
async function withFakeBitmap({ width, height }, fn) {
    const { createContext, runInContext } = await import('node:vm');
    // Re-evaluate the module in a context whose createImageBitmap returns
    // a bitmap of the requested dimensions. This is the cleanest way to
    // exercise _loadBitmap's gate without poking at module-private state.
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(modulePath, 'utf8');
    const fakeBitmap = { width, height, close: () => {} };
    const ctx = {
        window: { logger: { info(){}, error(){}, warn(){}, success(){}, debug(){} } },
        logger: { info(){}, error(){}, warn(){}, success(){}, debug(){} },
        document: stubDocument,
        createImageBitmap: async () => fakeBitmap,
        Blob: globalThis.Blob,
        Uint8Array: globalThis.Uint8Array,
        Promise: globalThis.Promise,
        console,
    };
    runInContext(code, createContext(ctx));
    return fn(ctx.window.ImageTransforms);
}

test('rotateImage throws when bitmap dimensions exceed MAX_TRANSFORM_PIXELS', async () => {
    // 20000 x 20000 = 400 MP, well above the 150 MP cap.
    await withFakeBitmap({ width: 20000, height: 20000 }, async (IT) => {
        const fakeInput = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' };
        await assert.rejects(
            () => IT.rotateImage(fakeInput, { degrees: 90 }),
            /image too large for transform/,
            'rotateImage must refuse a pathologically large peer bitmap'
        );
    });
});

test('rotateImage accepts a bitmap at the cap boundary', async () => {
    // 12000 x 12000 = 144 MP, just under 150 MP.
    await withFakeBitmap({ width: 12000, height: 12000 }, async (IT) => {
        const fakeInput = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' };
        // The stub canvas + drawImage path is benign and will resolve;
        // we only assert that the dimension gate does NOT trip here.
        // toBlob will throw because the stub canvas doesn't implement it,
        // but that happens AFTER the gate (which is what we're testing).
        await assert.rejects(
            () => IT.rotateImage(fakeInput, { degrees: 90 }),
            (e) => !/image too large for transform/.test(e.message),
            'rotateImage must NOT trip the dimension gate at 144 MP'
        );
    });
});
