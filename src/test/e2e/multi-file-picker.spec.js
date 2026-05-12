/**
 * Multi-file picker E2E tests.
 *
 * Regression cover for the v4.0.5 OOM fix: the Android picker
 * "Choose multiple files" path used to strip+queue every selected
 * image up front before invoking drain, peaking memory at N PNGs
 * and killing the renderer on phones. The fix pipelines strip+queue+drain
 * one-at-a-time and adds a 50-file hard cap.
 *
 * Three invariants are exercised here:
 *   1. Protocol shape           — exactly one batch-start, N file transfers, one batch-end
 *   2. Pipelining property      — at least one sendFile starts before the last push completes
 *   3. Hard cap (>50)           — selection is rejected with a toast and no protocol traffic
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/multi');

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const b of buf) {
        crc ^= b;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([typeBytes, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf));
    return Buffer.concat([len, typeBytes, data, crc]);
}

function makePng(r, g, b) {
    const w = 8, h = 8;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc(h * (1 + w * 3));
    for (let row = 0; row < h; row++) {
        const off = row * (1 + w * 3);
        raw[off] = 0;
        for (let c = 0; c < w; c++) {
            raw[off + 1 + c * 3] = r;
            raw[off + 2 + c * 3] = g;
            raw[off + 3 + c * 3] = b;
        }
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function ensureFixtures(n) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const paths = [];
    for (let i = 0; i < n; i++) {
        const p = path.join(FIXTURE_DIR, `img-${String(i).padStart(3, '0')}.png`);
        if (!fs.existsSync(p)) {
            fs.writeFileSync(p, makePng((i * 7) % 256, (i * 13) % 256, (i * 23) % 256));
        }
        paths.push(p);
    }
    return paths;
}

/**
 * Pair a receiver and sender context, walk both through the verification
 * modal, and return the pages ready for file transfers. Mirrors the flow
 * in two-peer-roundtrip.spec.js but kept local to avoid coupling.
 */
async function pairAndVerify(browser) {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await pageA.goto('/receive.html');
    await pageA.waitForSelector('#qr-url-input', { timeout: 12000 });
    const senderUrl = await pageA.inputValue('#qr-url-input');

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto(senderUrl);
    await pageB.waitForLoadState('domcontentloaded');

    await pageA.waitForFunction(() => {
        const m = document.getElementById('verification-modal');
        return m && !m.classList.contains('hidden');
    }, { timeout: 20000 });
    await pageA.click('#confirm-match-btn');

    await pageB.waitForFunction(() => {
        const m = document.getElementById('verification-modal');
        return m && !m.classList.contains('hidden');
    }, { timeout: 10000 }).catch(() => null);
    await pageB.$eval('#confirm-match-btn', btn => btn.click()).catch(() => null);

    // Wait until sender has a sharedKey (post-verification) so handleFileSelect won't bail
    await pageB.waitForFunction(
        () => window.SenderConnect && window.SenderConnect.getSharedKey() != null,
        { timeout: 15000 }
    );

    return { ctxA, pageA, ctxB, pageB };
}

/**
 * Install observation hooks on the sender page:
 *   - window.__protocolLog   : ordered list of message types passed to rtc.sendMessage
 *   - window.__sendFileCount : how many times rtc.sendFile was invoked
 *   - window.__pushCount     : how many times SenderSend.push was called
 *   - window.__pushesAtFirstSendFile : SenderSend.push count when first sendFile fires
 *   - window.__toasts        : ordered list of {message, type} from showToast
 *
 * These are the only things the assertions read; nothing inside SenderSend
 * is replaced beyond a thin wrapper that delegates to the original.
 */
async function installSenderHooks(page) {
    await page.evaluate(() => {
        window.__protocolLog = [];
        window.__sendFileCount = 0;
        window.__pushCount = 0;
        window.__pushesAtFirstSendFile = null;
        window.__toasts = [];

        // Wrap showToast (writable global on window)
        const origToast = window.showToast;
        window.showToast = (message, options) => {
            window.__toasts.push({ message, type: (options && options.type) || 'error' });
            return origToast(message, options);
        };

        // Wrap SenderSend (Object.freeze'd, but the window property itself is writable;
        // delegating wrapper is enough because internal state lives in the IIFE closure
        // and methods don't depend on `this`).
        const orig = window.SenderSend;
        window.SenderSend = {
            attach: orig.attach,
            push: (item) => { window.__pushCount += 1; return orig.push(item); },
            markBatchEndPending: orig.markBatchEndPending,
            removePhotoById: orig.removePhotoById,
            clear: orig.clear,
            size: orig.size,
            isActive: orig.isActive,
            drain: orig.drain,
            updateBanner: orig.updateBanner,
        };

        // Wrap the live RtcConnection instance methods. Done at hook-install
        // time because the rtc only exists post-key-exchange.
        const rtc = window.SenderConnect.getRtc();
        const origSendMessage = rtc.sendMessage.bind(rtc);
        rtc.sendMessage = (msg) => {
            if (msg && typeof msg.type === 'string') window.__protocolLog.push(msg.type);
            return origSendMessage(msg);
        };
        const origSendFile = rtc.sendFile.bind(rtc);
        rtc.sendFile = (...args) => {
            window.__sendFileCount += 1;
            if (window.__pushesAtFirstSendFile === null) {
                window.__pushesAtFirstSendFile = window.__pushCount;
            }
            return origSendFile(...args);
        };
    });
}

test.beforeAll(() => { ensureFixtures(51); });

test('multi-file picker: 3 files produce one batch-start, three transfers, one batch-end', async ({ browser }) => {
    const fixtures = ensureFixtures(3);
    const { ctxA, pageA, ctxB, pageB } = await pairAndVerify(browser);

    try {
        await installSenderHooks(pageB);
        await pageB.setInputFiles('#file-input', fixtures.slice(0, 3));

        // Wait for the full batch to land: 3 file-acks + a batch-end emitted by drain.
        await pageB.waitForFunction(
            () => (window.__protocolLog || []).includes('batch-end'),
            { timeout: 30000 }
        );

        const log = await pageB.evaluate(() => window.__protocolLog);
        const sendFileCount = await pageB.evaluate(() => window.__sendFileCount);

        const batchStarts = log.filter(t => t === 'batch-start').length;
        const batchEnds = log.filter(t => t === 'batch-end').length;
        expect(batchStarts).toBe(1);
        expect(batchEnds).toBe(1);
        expect(sendFileCount).toBe(3);
        expect(log.indexOf('batch-start')).toBeLessThan(log.indexOf('batch-end'));

        // Receiver should see exactly 3 cards/items.
        await pageA.waitForFunction(
            () => {
                const c = document.getElementById('received-images');
                if (!c) return false;
                return c.querySelectorAll('.received-image-item, .file-card, img').length >= 3;
            },
            { timeout: 15000 }
        );
    } finally {
        await ctxA.close();
        await ctxB.close();
    }
});

test('multi-file picker: pipelined strip+drain, sendFile begins before all pushes complete', async ({ browser }) => {
    const fixtures = ensureFixtures(5);
    const { ctxA, pageA, ctxB, pageB } = await pairAndVerify(browser);

    try {
        await installSenderHooks(pageB);
        await pageB.setInputFiles('#file-input', fixtures.slice(0, 5));

        await pageB.waitForFunction(
            () => (window.__protocolLog || []).includes('batch-end'),
            { timeout: 30000 }
        );

        const pushCount = await pageB.evaluate(() => window.__pushCount);
        const pushesAtFirstSendFile = await pageB.evaluate(() => window.__pushesAtFirstSendFile);

        expect(pushCount).toBe(5);
        // The pipelining property: at least one file transfer began before
        // all pushes finished. Under the old "strip-all-then-drain" code,
        // every push would complete before drain even started, so this
        // value would equal pushCount (5).
        expect(pushesAtFirstSendFile).not.toBeNull();
        expect(pushesAtFirstSendFile).toBeLessThan(pushCount);
    } finally {
        await ctxA.close();
        await ctxB.close();
    }
});

test('multi-file picker: hard cap rejects > 50 files with a warn toast and no protocol traffic', async ({ browser }) => {
    const fixtures = ensureFixtures(51);
    const { ctxA, pageA, ctxB, pageB } = await pairAndVerify(browser);

    try {
        await installSenderHooks(pageB);
        await pageB.setInputFiles('#file-input', fixtures);

        // Cap check is synchronous after files.length > 50, so a short wait
        // is enough to ensure no async processing slipped through.
        await pageB.waitForTimeout(750);

        const log = await pageB.evaluate(() => window.__protocolLog);
        const pushCount = await pageB.evaluate(() => window.__pushCount);
        const sendFileCount = await pageB.evaluate(() => window.__sendFileCount);
        const toasts = await pageB.evaluate(() => window.__toasts);

        expect(log.filter(t => t === 'batch-start').length).toBe(0);
        expect(pushCount).toBe(0);
        expect(sendFileCount).toBe(0);
        expect(toasts.some(t => t.type === 'warn' && /too many/i.test(t.message))).toBe(true);
    } finally {
        await ctxA.close();
        await ctxB.close();
    }
});
