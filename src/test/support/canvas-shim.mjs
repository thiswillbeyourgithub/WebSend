/**
 * Minimal ImageData factory for tests that need canvas-like pixel buffers
 * without a real browser. Tries the npm `canvas` package first; falls back
 * to a plain-JS stub that is enough for pure-algorithm tests (applyOtsu,
 * doc-detect with synthetic pixel data).
 *
 * Usage:
 *   import { makeImageData, canvasAvailable } from './canvas-shim.mjs';
 *   const imgData = makeImageData(width, height);   // RGBA Uint8ClampedArray
 */

let _createCanvas = null;
let _canvasAvailable = false;

try {
    const { createCanvas, ImageData } = await import('canvas');
    _createCanvas = createCanvas;
    globalThis.ImageData = ImageData; // expose for code that uses new ImageData(...)
    _canvasAvailable = true;
} catch {
    // canvas package not installed — use stub
}

export const canvasAvailable = _canvasAvailable;

/**
 * Create an ImageData-like object with an RGBA pixel buffer.
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray} [data] - optional pre-filled pixel data
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function makeImageData(width, height, data) {
    if (_canvasAvailable) {
        const canvas = _createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        const id = ctx.createImageData(width, height);
        if (data) id.data.set(data);
        return id;
    }
    // Plain-JS stub: sufficient for pure-algorithm tests
    const buf = data ? new Uint8ClampedArray(data) : new Uint8ClampedArray(width * height * 4);
    return { data: buf, width, height };
}

/**
 * Fill an ImageData with a horizontal gradient (left=black, right=white).
 * Useful for testing Otsu thresholding.
 */
export function makeGradientImageData(width, height) {
    const buf = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const v = Math.round((x / (width - 1)) * 255);
            const i = (y * width + x) * 4;
            buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
        }
    }
    return makeImageData(width, height, buf);
}
