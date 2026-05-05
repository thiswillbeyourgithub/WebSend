/**
 * Integration test for DocDetect on realistic camera shots.
 *
 * For each fixture in test/fixtures/doc-samples/*.jpg: run DocDetect, warp the
 * detected quad to a rectangle, and assert that ≥95% of cropped pixels are
 * "page-coloured". The page is bluish-white (B channel dominant, ~220-250) and
 * the test floor is warm tan (R dominant, B ~90-130) — so B ≥ R + 20 cleanly
 * classifies a pixel as page vs floor regardless of overall brightness gradients
 * across the page. Skips gracefully if the optional `canvas` devDep or the
 * fixtures are missing.
 *
 * Built with Claude Code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../fixtures/doc-samples');
const DOC_DETECT_PATH = path.resolve(__dirname, '../../public/js/doc-detect.js');

const BLUE_OVER_RED = 20;           // B - R ≥ this counts as page-coloured
const PASS_RATIO = 0.95;            // ≥95% of cropped pixels must be page-coloured

let canvasMod = null;
try { canvasMod = await import('canvas'); } catch { /* optional */ }

const samples = existsSync(SAMPLES_DIR)
    ? readdirSync(SAMPLES_DIR).filter(f => /\.(jpe?g|png)$/i.test(f)).sort()
    : [];

if (!canvasMod) {
    test('doc-detect samples — skipped (canvas devDep not installed)', { skip: true }, () => {});
} else if (samples.length === 0) {
    test('doc-detect samples — skipped (no fixtures in doc-samples/)', { skip: true }, () => {});
} else {
    const { createCanvas, loadImage, ImageData } = canvasMod;
    globalThis.ImageData = ImageData;

    // Load DocDetect once into a vm context with a minimal browser shim
    const code = readFileSync(DOC_DETECT_PATH, 'utf8');
    const win = {};
    const vmCtx = createContext({
        window: win,
        document: { createElement: (t) => t === 'canvas' ? createCanvas(1, 1) : (() => { throw new Error(t); })() },
        console,
    });
    runInContext(code + '; window.DocDetect = DocDetect;', vmCtx);
    const DocDetect = win.DocDetect;

    for (const file of samples) {
        test(`doc-detect crops ${file} to ≥${(PASS_RATIO * 100) | 0}% page-coloured pixels`, async () => {
            const img = await loadImage(path.join(SAMPLES_DIR, file));
            // node-canvas Images expose width/height; DocDetect reads naturalWidth/Height
            Object.defineProperty(img, 'naturalWidth', { value: img.width, configurable: true });
            Object.defineProperty(img, 'naturalHeight', { value: img.height, configurable: true });

            const corners = DocDetect.detectFromImage(img);
            assert.ok(corners, `no quad detected in ${file}`);

            const ratio = whitePixelRatio(img, corners, createCanvas);
            const fmt = (p) => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`;
            const cornersStr = `tl${fmt(corners.tl)} tr${fmt(corners.tr)} br${fmt(corners.br)} bl${fmt(corners.bl)}`;
            assert.ok(
                ratio >= PASS_RATIO,
                `${file}: only ${(ratio * 100).toFixed(1)}% of cropped pixels are page-coloured (need ≥${(PASS_RATIO * 100) | 0}%) — corners: ${cornersStr}`
            );
        });
    }
}

/**
 * Warp the detected quad back to a rectangle (bilinear sampling along the quad
 * edges — adequate for a coverage check; production uses a full homography in
 * image-transforms.js) and return the fraction of pixels with max(R,G,B) ≥ WHITE_THRESHOLD.
 */
function whitePixelRatio(img, normCorners, createCanvas) {
    const W = img.width, H = img.height;
    const c = {
        tl: { x: normCorners.tl.x * W, y: normCorners.tl.y * H },
        tr: { x: normCorners.tr.x * W, y: normCorners.tr.y * H },
        br: { x: normCorners.br.x * W, y: normCorners.br.y * H },
        bl: { x: normCorners.bl.x * W, y: normCorners.bl.y * H },
    };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const outW = Math.round(Math.max(dist(c.tl, c.tr), dist(c.bl, c.br)));
    const outH = Math.round(Math.max(dist(c.tl, c.bl), dist(c.tr, c.br)));

    const srcCanvas = createCanvas(W, H);
    srcCanvas.getContext('2d').drawImage(img, 0, 0);
    const src = srcCanvas.getContext('2d').getImageData(0, 0, W, H).data;

    const sample = (x, y) => {
        const xi = Math.max(0, Math.min(W - 1, x | 0));
        const yi = Math.max(0, Math.min(H - 1, y | 0));
        const i = (yi * W + xi) * 4;
        return [src[i], src[i + 1], src[i + 2]];
    };

    let pageCol = 0, total = 0;
    for (let oy = 0; oy < outH; oy++) {
        for (let ox = 0; ox < outW; ox++) {
            const u = ox / (outW - 1), v = oy / (outH - 1);
            const tx = c.tl.x * (1 - u) + c.tr.x * u;
            const ty = c.tl.y * (1 - u) + c.tr.y * u;
            const bx = c.bl.x * (1 - u) + c.br.x * u;
            const by = c.bl.y * (1 - u) + c.br.y * u;
            const [r, , b] = sample(tx * (1 - v) + bx * v, ty * (1 - v) + by * v);
            if (b - r >= BLUE_OVER_RED) pageCol++;
            total++;
        }
    }
    return total ? pageCol / total : 0;
}
