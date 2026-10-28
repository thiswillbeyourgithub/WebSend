/**
 * Received-PDF card actions E2E test.
 *
 * A received PDF's card menu offers "Export as images" (ZIP of one PNG per
 * page) and "Export as OCR PDF" (pages rasterized, OCRed, re-assembled as a
 * searchable PDF). Both rasterize the PDF with scribe.js's PDF renderer
 * (ScribeHandle.renderPdfPages) and then turn the per-page PNG data URLs
 * into Blobs, which must not go through fetch(): the CSP's connect-src
 * does not allow data: URLs.
 *
 * The input PDF is built by hand (standard Helvetica, nothing embedded) so
 * no binary fixture is needed. The OCR result is checked with poppler's
 * `pdftotext`; the spec is skipped when it is not installed.
 */

const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const { pairAndVerify, hasPdftotext } = require('./helpers');

/**
 * Build a minimal valid PDF with one line of Helvetica text per page
 * (standard-14 font, nothing embedded). Offsets in the xref table must be
 * exact byte positions, hence the incremental assembly.
 * @param {string[]} lines - one text line per page.
 * @returns {Buffer}
 */
function makeTextPdf(lines) {
    const objs = [];
    const pageIds = lines.map((_, i) => 4 + i * 2);
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${lines.length} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
    lines.forEach((text, i) => {
        const stream = `BT /F1 48 Tf 72 300 Td (${text}) Tj ET`;
        objs[pageIds[i]] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 396] '
            + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
        objs[pageIds[i] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    let out = '%PDF-1.4\n';
    const offsets = [];
    for (let id = 1; id < objs.length; id++) {
        offsets[id] = out.length;
        out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
    }
    const xrefAt = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

/** Click a received-PDF card menu entry (identified by its emoji) and return the download. */
async function clickPdfCardAction(pageA, emoji) {
    await pageA.click('#received-images .card-kebab-btn');
    const downloadPromise = pageA.waitForEvent('download', { timeout: 120000 });
    await pageA.locator('#received-images .card-menu-item', { hasText: emoji }).click();
    return downloadPromise;
}

test.describe('received PDF card actions', () => {
    test.skip(!hasPdftotext(), 'pdftotext (poppler-utils) is required to inspect the exported PDF');
    // Tesseract init + recognition of two 300 DPI pages + PDF assembly.
    test.setTimeout(240000);

    test('received PDF exports as page images and as OCR PDF', async ({ browser }) => {
        const { ctxA, pageA, ctxB, pageB } = await pairAndVerify(browser);
        try {
            const pdf = makeTextPdf(['ALPHA WEBSEND', 'SECOND PAGE']);
            // A single non-image file is sent automatically once selected.
            await pageB.setInputFiles('#file-input', { name: 'probe.pdf', mimeType: 'application/pdf', buffer: pdf });
            await pageA.waitForFunction(
                () => document.querySelector('#received-images a[id^="download-"]') !== null,
                null,
                { timeout: 30000 }
            );

            // "Export as images": a ZIP holding one PNG per page. client-zip
            // stores entries uncompressed, so names and PNG signatures are
            // visible in the raw bytes.
            const zipDl = await clickPdfCardAction(pageA, '📸');
            expect(zipDl.suggestedFilename()).toMatch(/^probe_pages_.*\.zip$/);
            const zipText = fs.readFileSync(await zipDl.path()).toString('latin1');
            expect(zipText).toContain('probe_page_1.png');
            expect(zipText).toContain('probe_page_2.png');
            expect(zipText).not.toContain('probe_page_3.png');
            expect(zipText.split('\x89PNG\r\n\x1a\n').length - 1).toBeGreaterThanOrEqual(2);

            // "Export as OCR PDF": the rasterized pages were OCRed, so the
            // words come back from the invisible text layer.
            const ocrDl = await clickPdfCardAction(pageA, '📝');
            expect(ocrDl.suggestedFilename()).toMatch(/^probe_ocr_.*\.pdf$/);
            const text = execFileSync('pdftotext', [await ocrDl.path(), '-'], { encoding: 'utf8' }).toUpperCase();
            expect(text).toContain('WEBSEND');
            expect(text).toContain('SECOND');
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    });
});
