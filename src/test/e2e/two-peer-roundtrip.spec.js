/**
 * Two-peer round-trip E2E test.
 *
 * Opens receive.html in context A, extracts the room URL from the page,
 * opens send.html in context B at that URL, accepts fingerprints on both sides,
 * sends a file, and verifies the receiver gets it.
 */

const { test, expect } = require('@playwright/test');
const { pairAndVerify } = require('./helpers');
const path = require('path');
const fs = require('fs');

const FIXTURE_PNG = path.resolve(__dirname, '../fixtures/test-image.png');

// Create a valid 8x8 red PNG fixture using proper zlib-deflated IDAT
function ensureFixture() {
    if (fs.existsSync(FIXTURE_PNG)) return;
    const zlib = require('zlib');

    function crc32(buf) {
        let crc = 0xFFFFFFFF;
        for (const b of buf) {
            crc ^= b;
            for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function chunk(type, data) {
        const typeBytes = Buffer.from(type, 'ascii');
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const crcBuf = Buffer.concat([typeBytes, data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf));
        return Buffer.concat([len, typeBytes, data, crc]);
    }

    const w = 8, h = 8;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB, no interlace

    const raw = Buffer.alloc(h * (1 + w * 3));
    for (let r = 0; r < h; r++) {
        const off = r * (1 + w * 3);
        raw[off] = 0; // filter: none
        for (let c = 0; c < w; c++) {
            raw[off + 1 + c * 3] = 255; // R
            raw[off + 2 + c * 3] = 0;   // G
            raw[off + 3 + c * 3] = 0;   // B
        }
    }

    const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);

    fs.mkdirSync(path.dirname(FIXTURE_PNG), { recursive: true });
    fs.writeFileSync(FIXTURE_PNG, png);
}

// Multi-segment fixture: ~1.5 MiB of random bytes spans 7 SEG_SIZE
// (256 KiB) records and is incompressible, so it exercises the chunked
// v2 path (per-segment AEAD, uncompressed flag, partial final segment)
// that the single-record 8x8 PNG cannot reach. Random, so the SHA-256
// integrity check is computed per run, not hard-coded.
const FIXTURE_BIG = path.resolve(__dirname, '../fixtures/test-large.bin');
const BIG_SIZE = 1536 * 1024 + 7; // deliberately not record-aligned

function ensureBigFixture() {
    if (fs.existsSync(FIXTURE_BIG) && fs.statSync(FIXTURE_BIG).size === BIG_SIZE) return;
    fs.mkdirSync(path.dirname(FIXTURE_BIG), { recursive: true });
    fs.writeFileSync(FIXTURE_BIG, require('crypto').randomBytes(BIG_SIZE));
}

test.beforeAll(ensureFixture);

test('receiver page creates a room and shows a QR/URL', async ({ page }) => {
    await page.goto('/receive.html');
    await page.waitForSelector('#qr-url-input', { timeout: 12000 });
    const url = await page.inputValue('#qr-url-input');
    expect(url).toContain('/send/');
    expect(url).toContain('#');
});

test('two-peer file transfer round-trip', async ({ browser }) => {
    const { ctxA, pageA, ctxB, pageB } = await pairAndVerify(browser);

    // Sender: set file directly on the hidden input (bypasses the visible button click)
    await pageB.setInputFiles('#file-input', FIXTURE_PNG);

    // Single-image flow shows a preview; click "Send Photo" to actually transmit
    await pageB.waitForFunction(
        () => {
            const btn = document.getElementById('send-btn');
            return btn && !btn.classList.contains('hidden');
        },
        { timeout: 10000 }
    ).catch(() => null);
    await pageB.$eval('#send-btn', btn => btn.click()).catch(() => null);

    // Wait for receiver to show a received image/file card
    await pageA.waitForFunction(
        () => {
            const container = document.getElementById('received-images');
            if (!container) return false;
            return container.querySelector('.received-image-item, .file-card, img') !== null;
        },
        { timeout: 30000 }
    );

    const receivedItems = await pageA.$$('#received-images .received-image-item, #received-images .file-card, #received-images img');
    expect(receivedItems.length).toBeGreaterThan(0);

    await ctxA.close();
    await ctxB.close();
});

test('multi-segment file (>1 MiB) arrives byte-identical', async ({ browser }) => {
    ensureBigFixture();
    const expectedSha = require('crypto')
        .createHash('sha256').update(fs.readFileSync(FIXTURE_BIG)).digest('hex');

    const { ctxA, pageA, ctxB, pageB } = await pairAndVerify(browser);
    try {
        // A single non-image file is sent automatically once selected
        // (pairAndVerify already waited for the shared key).
        await pageB.setInputFiles('#file-input', FIXTURE_BIG);

        // Non-image files render as a generic file card with a download link.
        await pageA.waitForFunction(
            () => document.querySelector('#received-images a[id^="download-"]') !== null,
            { timeout: 60000 }
        );

        // Download the received file through the real UI (in-page fetch of
        // the blob: URL is blocked by the connect-src 'self' CSP) and hash
        // it node-side: end-to-end integrity across chunked AEAD, per-segment
        // (de)compression decisions, and reassembly. The download anchor
        // lives in the card's kebab menu, which starts hidden.
        await pageA.click('#received-images .card-kebab-btn');
        const downloadPromise = pageA.waitForEvent('download', { timeout: 30000 });
        await pageA.click('#received-images a[id^="download-"]');
        const download = await downloadPromise;
        const gotSha = require('crypto')
            .createHash('sha256')
            .update(fs.readFileSync(await download.path()))
            .digest('hex');
        expect(gotSha).toBe(expectedSha);
    } finally {
        await ctxA.close();
        await ctxB.close();
    }
});
