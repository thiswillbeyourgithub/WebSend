/**
 * Two-peer round-trip E2E test.
 *
 * Opens receive.html in context A, extracts the room URL from the page,
 * opens send.html in context B at that URL, accepts fingerprints on both sides,
 * sends a file, and verifies the receiver gets it.
 */

const { test, expect } = require('@playwright/test');
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

test.beforeAll(ensureFixture);

test('receiver page creates a room and shows a QR/URL', async ({ page }) => {
    await page.goto('/receive.html');
    await page.waitForSelector('#qr-url-input', { timeout: 12000 });
    const url = await page.inputValue('#qr-url-input');
    expect(url).toContain('/send/');
    expect(url).toContain('#');
});

test('two-peer file transfer round-trip', async ({ browser }) => {
    // Context A = receiver
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await pageA.goto('/receive.html');

    await pageA.waitForSelector('#qr-url-input', { timeout: 12000 });
    const senderUrl = await pageA.inputValue('#qr-url-input');

    // Context B = sender
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto(senderUrl);
    await pageB.waitForLoadState('domcontentloaded');

    // Wait for WebRTC connection + key exchange (both sides show verification modal)
    // The modal becomes visible when the fingerprint is ready — wait for it
    await pageA.waitForFunction(
        () => {
            const modal = document.getElementById('verification-modal');
            if (!modal) return false;
            // Modal is shown when it does NOT have the 'hidden' class
            return !modal.classList.contains('hidden');
        },
        { timeout: 20000 }
    );

    // Click Accept on receiver side
    await pageA.click('#confirm-match-btn');

    // Wait for sender verification modal too
    await pageB.waitForFunction(
        () => {
            const modal = document.getElementById('verification-modal');
            return modal && !modal.classList.contains('hidden');
        },
        { timeout: 10000 }
    ).catch(() => null);
    await pageB.$eval('#confirm-match-btn', btn => btn.click()).catch(() => null);

    // Wait for both sides to be in "connected" state (past verification)
    await pageA.waitForFunction(
        () => !document.getElementById('verification-modal') ||
              document.getElementById('verification-modal').classList.contains('hidden'),
        { timeout: 10000 }
    ).catch(() => null);

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
