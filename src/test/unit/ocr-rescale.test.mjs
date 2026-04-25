import { test } from 'node:test';
import assert from 'node:assert';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/ocr-rescale.js');

function makePage() {
    return {
        dims: { width: 1000, height: 2000 },
        lines: [
            {
                bbox: { left: 10, top: 20, right: 110, bottom: 60 },
                ascHeight: 30,
                xHeight: 20,
                baseline: [0.0, 50],
                words: [
                    {
                        bbox: { left: 10, top: 20, right: 60, bottom: 60 },
                        chars: [
                            { bbox: { left: 10, top: 20, right: 20, bottom: 60 } },
                            { bbox: { left: 20, top: 20, right: 30, bottom: 60 } },
                        ],
                    },
                    {
                        // No `chars`; should be tolerated
                        bbox: { left: 70, top: 20, right: 110, bottom: 60 },
                    },
                ],
            },
        ],
    };
}

test('rescaleOcrPage: scales bboxes, baseline, asc/xHeight when s != 1', async () => {
    const win = await loadBrowserModule(modulePath);
    const { rescaleOcrPage } = win.OcrRescale;

    const page = makePage();
    const metrics = { dims: { width: 1000, height: 2000 } };
    const s = rescaleOcrPage(page, metrics, 2000, 4000);

    assert.equal(s, 2);
    const line = page.lines[0];
    assert.deepEqual(line.bbox, { left: 20, top: 40, right: 220, bottom: 120 });
    assert.equal(line.ascHeight, 60);
    assert.equal(line.xHeight, 40);
    assert.equal(line.baseline[1], 100);

    const word0 = line.words[0];
    assert.deepEqual(word0.bbox, { left: 20, top: 40, right: 120, bottom: 120 });
    assert.deepEqual(word0.chars[0].bbox, { left: 20, top: 40, right: 40, bottom: 120 });
    assert.deepEqual(word0.chars[1].bbox, { left: 40, top: 40, right: 60, bottom: 120 });

    // Word without chars must not throw
    assert.deepEqual(line.words[1].bbox, { left: 140, top: 40, right: 220, bottom: 120 });

    // Page + metrics dims updated
    assert.deepEqual(page.dims, { width: 2000, height: 4000 });
    assert.deepEqual(metrics.dims, { width: 2000, height: 4000 });
});

test('rescaleOcrPage: near-identity (|s-1| <= 0.01) leaves coords untouched', async () => {
    const win = await loadBrowserModule(modulePath);
    const { rescaleOcrPage } = win.OcrRescale;

    const page = makePage();
    const before = JSON.parse(JSON.stringify(page.lines));
    const metrics = { dims: { width: 1000, height: 2000 } };

    // 0.5% delta -> within the 1% no-op threshold
    const s = rescaleOcrPage(page, metrics, 1005, 2010);

    assert.ok(Math.abs(s - 1) < 0.01);
    assert.deepEqual(page.lines, before, 'lines must not be mutated when s ~= 1');
    // metrics dims still get assigned (cheap, idempotent)
    assert.equal(metrics.dims.width, 1005);
    assert.equal(metrics.dims.height, 2010);
});

test('rescaleOcrPage: tolerates missing ascHeight/xHeight', async () => {
    const win = await loadBrowserModule(modulePath);
    const { rescaleOcrPage } = win.OcrRescale;

    const page = {
        dims: { width: 100, height: 100 },
        lines: [
            {
                bbox: { left: 0, top: 0, right: 10, bottom: 10 },
                baseline: [0, 5],
                words: [{ bbox: { left: 0, top: 0, right: 10, bottom: 10 } }],
            },
        ],
    };
    const metrics = { dims: { width: 100, height: 100 } };
    const s = rescaleOcrPage(page, metrics, 200, 200);

    assert.equal(s, 2);
    assert.equal(page.lines[0].bbox.right, 20);
    assert.equal(page.lines[0].baseline[1], 10);
});

test('rescaleOcrPage: page without lines still updates metrics', async () => {
    const win = await loadBrowserModule(modulePath);
    const { rescaleOcrPage } = win.OcrRescale;

    const page = { dims: { width: 100, height: 100 } };
    const metrics = { dims: { width: 100, height: 100 } };
    const s = rescaleOcrPage(page, metrics, 300, 300);

    assert.equal(s, 3);
    assert.equal(metrics.dims.width, 300);
    assert.equal(metrics.dims.height, 300);
});
