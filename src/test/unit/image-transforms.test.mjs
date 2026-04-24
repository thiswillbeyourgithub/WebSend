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
const { applyOtsu, perspectiveTransform, distance } = win.ImageTransforms;

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
