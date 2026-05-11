/**
 * Unit tests for js/sender-send.js, focused on the defense-in-depth
 * verification gate inside sendOnePhoto. The drain loop is allowed to
 * pull items off the queue and try to send; the test asserts that
 * sending is refused (and the photo marked failed) when isVerified()
 * is false, and proceeds normally when it is true. This catches a
 * regression where any future code path that advances the UI past
 * verification would silently leak plaintext over the wire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/sender-send.js');
const moduleSource = readFileSync(modulePath, 'utf8');

function loadIntoJsdom({ verified }) {
    const dom = new JSDOM(
        '<!doctype html><html><body>' +
        '<div id="queue-banner" class="hidden"></div>' +
        '<span id="queue-banner-text"></span>' +
        '<div id="queue-progress-fill"></div>' +
        '<div id="queue-transfer-stats"></div>' +
        '</body></html>',
        { runScripts: 'outside-only', url: 'http://localhost/' }
    );
    const win = dom.window;

    const sentFiles = [];
    const sentMessages = [];
    win.WebSendCrypto = {
        sha256Hex: async () => 'deadbeef',
        encryptWithMetadata: async (data) => new ArrayBuffer(data.byteLength),
    };
    win.Protocol = {
        build: {
            replaceImage: (h) => ({ type: 'replace-image', hash: h }),
            batchEnd: () => ({ type: 'batch-end' }),
        },
    };
    win.formatRate = () => '0 kB/s';
    win.formatTransferStats = () => '';

    const fakeRtc = {
        sendMessage: (m) => sentMessages.push(m),
        sendFile: async (buf) => { sentFiles.push(buf); },
    };

    const logs = { info: [], warn: [], error: [], success: [] };
    const toasts = [];
    const deps = {
        getRtc: () => fakeRtc,
        getSharedKey: () => ({ __fake: 'key' }),
        isVerified: () => verified,
        i18n: { t: (k) => k },
        logger: {
            info: (m) => logs.info.push(m),
            warn: (m) => logs.warn.push(m),
            error: (m) => logs.error.push(m),
            success: (m) => logs.success.push(m),
        },
        showToast: (m) => toasts.push(m),
        getGalleryPhotos: () => [],
    };

    // Load module into the jsdom realm
    const script = new win.Function(moduleSource);
    script.call(win);

    win.SenderSend.attach(deps);
    return { win, sentFiles, sentMessages, logs, toasts };
}

function makeBlob(win) {
    return new win.Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
}

test('sendOnePhoto refuses to transmit when peer is not verified', async () => {
    const { win, sentFiles, logs } = loadIntoJsdom({ verified: false });
    win.SenderSend.push({ blob: makeBlob(win) });
    await win.SenderSend.drain();
    assert.equal(sentFiles.length, 0, 'no file bytes should leave the host');
    assert.ok(
        logs.error.some(m => /not verified|Refusing to send/.test(m)),
        `error log should mention verification refusal, got: ${JSON.stringify(logs.error)}`
    );
});

test('sendOnePhoto transmits when peer is verified', async () => {
    const { win, sentFiles } = loadIntoJsdom({ verified: true });
    win.SenderSend.push({ blob: makeBlob(win) });
    await win.SenderSend.drain();
    assert.equal(sentFiles.length, 1, 'exactly one encrypted blob should be sent');
});
