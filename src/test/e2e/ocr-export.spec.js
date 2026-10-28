/**
 * OCR (searchable PDF) export E2E tests.
 *
 * This is the only test layer that runs the vendored scribe.js for real
 * (Tesseract WASM, worker pool, PDF writer), so it is the safety net for
 * scribe.js upgrades: scribe-handle.js, bg-ocr.js and receive-export.js
 * reach into scribe internals (per-page OCR objects, page metrics, native
 * image slots) that are not a stable public API.
 *
 * Both export paths of generateOcrPdf are covered:
 *   1. cached path:   background OCR (bg-ocr.js) ran on a downscaled copy,
 *                     its page is rescaled and spliced onto the original-size
 *                     image (applyCachedOcrToScribe);
 *   2. fallback path: cached data is unusable, so the export re-runs OCR on
 *                     demand and swaps in the original image
 *                     (ocrRecognizeAndExport).
 *
 * The test image is rendered in the browser, 2400 px wide, i.e. above the
 * 2000 px OCR input cap, so both paths go through the downscale + rescale
 * logic. A word is placed at the horizontal middle of the image: if the OCR
 * coordinates were not rescaled to the original size, the word would land at
 * 2000/2400 = 83% of its expected x position in the PDF, which the bbox
 * assertion catches.
 *
 * The PDF is checked with poppler's `pdftotext -bbox`; the spec is skipped
 * when it is not installed.
 */

const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const { pairAndVerify, hasPdftotext } = require('./helpers');

const IMG_W = 2400;
const IMG_H = 900;
// Left edge of the probe word, as a fraction of the image width.
const PROBE_X_FRAC = 0.5;
const PROBE_WORD = 'WEBSEND';

/**
 * Extract the words of page 1 of a PDF with their bbox normalized to the
 * page size, e.g. [{ text: 'WEBSEND', x0: 0.5, y0: 0.14, x1: 0.83, y1: 0.28 }].
 */
function pdfWords(pdfPath) {
    const html = execFileSync('pdftotext', ['-bbox', '-f', '1', '-l', '1', pdfPath, '-'], { encoding: 'utf8' });
    const page = html.match(/<page width="([\d.]+)" height="([\d.]+)">/);
    if (!page) throw new Error('pdftotext found no page in the exported PDF');
    const [pw, ph] = [parseFloat(page[1]), parseFloat(page[2])];
    const words = [];
    const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        words.push({
            text: m[5],
            x0: parseFloat(m[1]) / pw, y0: parseFloat(m[2]) / ph,
            x1: parseFloat(m[3]) / pw, y1: parseFloat(m[4]) / ph,
        });
    }
    return words;
}

/**
 * Render the test document in the sender page: black bold text on white,
 * one line with a left word and the probe word, one line below it.
 * Returns a PNG Buffer.
 */
async function renderTestImage(page) {
    const b64 = await page.evaluate(async ({ w, h, probeX, probe }) => {
        const cv = new OffscreenCanvas(w, h);
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#000';
        ctx.font = 'bold 150px sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('ALPHA', 150, 300);
        ctx.fillText(probe, Math.round(w * probeX), 300);
        ctx.fillText('SEARCHABLE PDF', 150, 650);
        const blob = await cv.convertToBlob({ type: 'image/png' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
    }, { w: IMG_W, h: IMG_H, probeX: PROBE_X_FRAC, probe: PROBE_WORD });
    return Buffer.from(b64, 'base64');
}

/**
 * Pair, send the test image, and wait until the receiver's background OCR
 * produced cached page data for it.
 */
async function sendImageAndAwaitBgOcr(browser) {
    const session = await pairAndVerify(browser);
    const { pageA, pageB } = session;
    const png = await renderTestImage(pageB);
    await pageB.setInputFiles('#file-input', { name: 'ocr-test.png', mimeType: 'image/png', buffer: png });

    // Single-image flow shows a preview; "Send Photo" actually transmits.
    await pageB.waitForFunction(() => {
        const btn = document.getElementById('send-btn');
        return btn && !btn.classList.contains('hidden');
    }, { timeout: 10000 }).catch(() => null);
    await pageB.$eval('#send-btn', btn => btn.click()).catch(() => null);

    // receivedImages is a top-level `let` of receive.html's inline script,
    // hence reachable by name from evaluate (global lexical scope).
    // First OCR run downloads and initializes Tesseract + eng/fra models.
    await pageA.waitForFunction(
        () => receivedImages.length === 1 && receivedImages[0].ocrPageData != null,
        null,
        { timeout: 120000 }
    );
    return session;
}

/** Drive the export modal to an OCR PDF and return the downloaded file path. */
async function exportOcrPdf(pageA) {
    await pageA.click('#export-btn');
    await pageA.click('.export-seg-btn[data-format="pdf"]');
    await pageA.click('#export-ocr');
    await expect(pageA.locator('#export-ocr')).toHaveClass(/active/);
    const downloadPromise = pageA.waitForEvent('download', { timeout: 120000 });
    await pageA.click('#export-confirm-btn');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/_ocr_.*\.pdf$/);
    return download.path();
}

function assertSearchableLayer(pdfPath) {
    expect(fs.readFileSync(pdfPath).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const words = pdfWords(pdfPath);
    const texts = words.map(w => w.text.toUpperCase());
    expect(texts).toContain('ALPHA');
    expect(texts).toContain(PROBE_WORD);
    expect(texts).toContain('SEARCHABLE');

    // Geometry: the probe word must sit where it was drawn on the
    // original-size image (see file header for why this catches a missing
    // rescale), and the second line must be below the first.
    const probe = words.find(w => w.text.toUpperCase() === PROBE_WORD);
    expect(probe.x0).toBeGreaterThan(PROBE_X_FRAC - 0.03);
    expect(probe.x0).toBeLessThan(PROBE_X_FRAC + 0.03);
    expect(probe.x1).toBeLessThanOrEqual(1);
    const second = words.find(w => w.text.toUpperCase() === 'SEARCHABLE');
    expect(second.y0).toBeGreaterThan(probe.y1);
}

test.describe('OCR searchable PDF export', () => {
    test.skip(!hasPdftotext(), 'pdftotext (poppler-utils) is required to inspect the exported PDF');
    // Tesseract init + recognition on a 2000 px image + PDF assembly.
    test.setTimeout(240000);

    test('cached background-OCR page is rescaled onto the original image', async ({ browser }) => {
        const { ctxA, ctxB, pageA } = await sendImageAndAwaitBgOcr(browser);
        const logs = [];
        pageA.on('console', m => logs.push(m.text()));
        try {
            const pdfPath = await exportOcrPdf(pageA);
            assertSearchableLayer(pdfPath);
            // Proves the cached splice ran rather than a silent fallback.
            expect(logs.some(l => l.includes('PDF assembled from cached OCR data successfully'))).toBe(true);
            expect(logs.some(l => l.includes('[OCR fallback]'))).toBe(false);
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    });

    test('unusable cached OCR falls back to on-demand OCR', async ({ browser }) => {
        const { ctxA, ctxB, pageA } = await sendImageAndAwaitBgOcr(browser);
        const logs = [];
        pageA.on('console', m => logs.push(m.text()));
        try {
            // Non-null ocrPageData counts as cached, but a null page makes
            // applyCachedOcrToScribe throw, which triggers the fallback.
            await pageA.evaluate(() => { receivedImages[0].ocrPageData = { page: null, metrics: null }; });
            const pdfPath = await exportOcrPdf(pageA);
            assertSearchableLayer(pdfPath);
            expect(logs.some(l => l.includes('[OCR fallback] PDF generated successfully'))).toBe(true);
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    });

});
