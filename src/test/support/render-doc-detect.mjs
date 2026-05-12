#!/usr/bin/env node
/**
 * Debug helper: for each sample in test/fixtures/doc-samples/, run DocDetect
 * and write three PNGs to /tmp/doc-detect-debug/<name>/:
 *   - quad.png    sample with detected quad drawn on top (and corner dots)
 *   - crop.png    perspective-warped output at target dimensions
 *   - target.png  ground-truth target (copied for side-by-side viewing)
 *
 * Run with: node src/test/support/render-doc-detect.mjs
 *
 * Built with Claude Code.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import * as canvasMod from 'canvas';

const { createCanvas, loadImage, ImageData } = canvasMod;
globalThis.ImageData = ImageData;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../fixtures/doc-samples');
const TARGETS_DIR = path.resolve(__dirname, '../fixtures/doc-target-result');
const OUT_DIR = path.join(process.env.TMPDIR || '/tmp', 'doc-detect-debug');
const DOC_DETECT_PATH = path.resolve(__dirname, '../../public/js/doc-detect.js');
const IMG_TRANSFORMS_PATH = path.resolve(__dirname, '../../public/js/image-transforms.js');

const win = {};
const vmCtx = createContext({
    window: win,
    document: { createElement: (t) => t === 'canvas' ? createCanvas(1, 1) : (() => { throw new Error(t); })() },
    ImageData,
    console,
});
runInContext(readFileSync(DOC_DETECT_PATH, 'utf8') + '; window.DocDetect = DocDetect;', vmCtx);
runInContext(readFileSync(IMG_TRANSFORMS_PATH, 'utf8'), vmCtx);
const { DocDetect, ImageTransforms } = win;

mkdirSync(OUT_DIR, { recursive: true });
const samples = readdirSync(SAMPLES_DIR).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();

for (const file of samples) {
    const targetPath = path.join(TARGETS_DIR, file);
    const stem = path.parse(file).name;
    const outSub = path.join(OUT_DIR, stem);
    mkdirSync(outSub, { recursive: true });

    const srcImg = await loadImage(path.join(SAMPLES_DIR, file));
    Object.defineProperty(srcImg, 'naturalWidth',  { value: srcImg.width,  configurable: true });
    Object.defineProperty(srcImg, 'naturalHeight', { value: srcImg.height, configurable: true });

    const norm = DocDetect.detectFromImage(srcImg);
    if (!norm) { console.log(`${file}: no quad detected`); continue; }

    const W = srcImg.width, H = srcImg.height;
    const px = (p) => ({ x: p.x * W, y: p.y * H });
    const c = { tl: px(norm.tl), tr: px(norm.tr), br: px(norm.br), bl: px(norm.bl) };

    // quad.png — sample with quad overlay
    const overlay = createCanvas(W, H);
    const ctx = overlay.getContext('2d');
    ctx.drawImage(srcImg, 0, 0);
    ctx.lineWidth = Math.max(4, W / 400);
    ctx.strokeStyle = 'red';
    ctx.beginPath();
    ctx.moveTo(c.tl.x, c.tl.y);
    ctx.lineTo(c.tr.x, c.tr.y);
    ctx.lineTo(c.br.x, c.br.y);
    ctx.lineTo(c.bl.x, c.bl.y);
    ctx.closePath();
    ctx.stroke();
    const r = Math.max(8, W / 200);
    for (const [name, p] of Object.entries(c)) {
        ctx.fillStyle = ({ tl: 'lime', tr: 'cyan', br: 'magenta', bl: 'yellow' })[name];
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    }
    writeFileSync(path.join(outSub, 'quad.png'), overlay.toBuffer('image/png'));

    // crop.png — warped at target dimensions
    if (existsSync(targetPath)) {
        const tgtImg = await loadImage(targetPath);
        const srcCorners = [c.tl, c.tr, c.br, c.bl];
        const cropCanvas = ImageTransforms.perspectiveTransform(srcImg, srcCorners, tgtImg.width, tgtImg.height);
        writeFileSync(path.join(outSub, 'crop.png'), cropCanvas.toBuffer('image/png'));

        // target.png — copy for side-by-side
        const tCanvas = createCanvas(tgtImg.width, tgtImg.height);
        tCanvas.getContext('2d').drawImage(tgtImg, 0, 0);
        writeFileSync(path.join(outSub, 'target.png'), tCanvas.toBuffer('image/png'));
    }

    const fmt = (p) => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`;
    console.log(`${file}: tl${fmt(norm.tl)} tr${fmt(norm.tr)} br${fmt(norm.br)} bl${fmt(norm.bl)}`);
}
console.log(`\nWrote debug images to ${OUT_DIR}/`);
