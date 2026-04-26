import { test } from 'node:test';
import assert from 'node:assert';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/pdf-builder.js');

// Decode a Uint8Array slice as Latin-1 (PDF text segments are 1-byte-per-char).
function latin1(bytes, start = 0, end = bytes.length) {
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
}

// Parse the xref table out of a builder-produced PDF and return
// { startxref, size, offsets } — re-derived from the bytes, not from the builder.
function parseXref(bytes) {
    const text = latin1(bytes);
    const startxrefIdx = text.lastIndexOf('startxref');
    assert.ok(startxrefIdx !== -1, 'startxref marker missing');
    const after = text.slice(startxrefIdx + 'startxref'.length).trim();
    const startxref = parseInt(after.split(/\s+/)[0], 10);

    const xrefHeader = latin1(bytes, startxref, startxref + 4);
    assert.equal(xrefHeader, 'xref', 'startxref does not point to xref');

    // Read "xref\n0 N\n" then N entries of 20 bytes each ("nnnnnnnnnn ggggg f \n").
    const headerEnd = text.indexOf('\n', startxref + 5); // skip "xref\n"
    const sizeLine = text.slice(startxref + 5, headerEnd); // "0 N"
    const size = parseInt(sizeLine.split(' ')[1], 10);

    const offsets = [];
    let cursor = headerEnd + 1;
    for (let i = 0; i < size; i++) {
        const entry = text.slice(cursor, cursor + 20);
        offsets.push(parseInt(entry.slice(0, 10), 10));
        cursor += 20;
    }
    return { startxref, size, offsets };
}

// Tiny "fake JPEG" — buildPdf treats the data as opaque bytes (it embeds them
// as a DCTDecode stream and only uses .length / .width / .height in headers).
// We don't need a real JPEG to verify PDF structural correctness.
function fakeJpeg(width, height, byte = 0xAA, len = 32) {
    return { width, height, data: new Uint8Array(len).fill(byte) };
}

test('buildPdf: single image — header, EOF, xref offsets, trailer Size', async () => {
    const win = await loadBrowserModule(modulePath);
    const { buildPdf } = win.PdfBuilder;

    const pdf = buildPdf([fakeJpeg(100, 200)]);
    const text = latin1(pdf);

    assert.ok(text.startsWith('%PDF-1.4\n'), 'must start with %PDF-1.4');
    assert.ok(text.trimEnd().endsWith('%%EOF'), 'must end with %%EOF');
    assert.equal(text.match(/\bxref\b/g).length, 1, 'exactly one xref table');

    // 1 image -> 5 objects: catalog, pages, image, stream, page
    const expectedObjCount = 5;
    const { size, offsets } = parseXref(pdf);
    assert.equal(size, expectedObjCount + 1, 'xref size includes free entry');
    assert.equal(offsets.length, expectedObjCount + 1);
    assert.equal(offsets[0], 0, 'free entry offset is 0');

    // Each non-free offset must point at "<idx> 0 obj"
    for (let i = 1; i <= expectedObjCount; i++) {
        const at = latin1(pdf, offsets[i], offsets[i] + 16);
        assert.ok(at.startsWith(`${i} 0 obj`), `offset ${i} should point at "${i} 0 obj", got "${at}"`);
    }

    // trailer /Size matches xref size
    const trailerMatch = text.match(/trailer\s*<<([^>]+)>>/);
    assert.ok(trailerMatch, 'trailer dict present');
    assert.match(trailerMatch[1], new RegExp(`/Size\\s+${expectedObjCount + 1}\\b`));
    assert.match(trailerMatch[1], /\/Root\s+1\s+0\s+R/);
});

test('buildPdf: two images — two distinct pages, two distinct image XObjects', async () => {
    const win = await loadBrowserModule(modulePath);
    const { buildPdf } = win.PdfBuilder;

    const pdf = buildPdf([fakeJpeg(50, 60, 0x11), fakeJpeg(70, 80, 0x22)]);
    const text = latin1(pdf);

    // 2 images -> 2 (catalog+pages) + 2*(image+stream+page) = 8 objects
    const { size } = parseXref(pdf);
    assert.equal(size, 9);

    // Pages object lists exactly 2 kids
    const pagesMatch = text.match(/\/Type \/Pages \/Kids \[ ([^\]]+) \] \/Count (\d+)/);
    assert.ok(pagesMatch, 'Pages dict present');
    assert.equal(pagesMatch[2], '2');
    const kids = pagesMatch[1].trim().split(/\s+0\s+R\s*/).filter(Boolean);
    assert.equal(kids.length, 2, 'two distinct page refs');
    assert.notEqual(kids[0], kids[1], 'page refs must differ');

    // Two distinct /Im<N> resource references — one per page
    const imRefs = [...text.matchAll(/\/XObject << \/Im(\d+) /g)].map(m => m[1]);
    assert.equal(imRefs.length, 2);
    assert.notEqual(imRefs[0], imRefs[1], 'image XObject ids must differ between pages');

    // MediaBox sizes match input dims
    const mediaBoxes = [...text.matchAll(/\/MediaBox \[0 0 (\d+) (\d+)\]/g)].map(m => [m[1], m[2]]);
    assert.deepEqual(mediaBoxes, [['50', '60'], ['70', '80']]);
});

test('buildPdf: empty input — produces structurally valid PDF with no pages', async () => {
    const win = await loadBrowserModule(modulePath);
    const { buildPdf } = win.PdfBuilder;

    // Lock in current behaviour: empty input yields a PDF with just catalog+pages,
    // /Count 0 and no /Kids entries. (Some viewers may reject this, but the
    // builder itself doesn't throw — that's the contract for now.)
    const pdf = buildPdf([]);
    const text = latin1(pdf);

    assert.ok(text.startsWith('%PDF-1.4\n'));
    assert.ok(text.trimEnd().endsWith('%%EOF'));

    const { size, offsets } = parseXref(pdf);
    assert.equal(size, 3, 'free + catalog + pages');
    const at1 = latin1(pdf, offsets[1], offsets[1] + 8);
    assert.ok(at1.startsWith('1 0 obj'));
    const at2 = latin1(pdf, offsets[2], offsets[2] + 8);
    assert.ok(at2.startsWith('2 0 obj'));

    assert.match(text, /\/Type \/Pages \/Kids \[\s*\] \/Count 0/);
});
