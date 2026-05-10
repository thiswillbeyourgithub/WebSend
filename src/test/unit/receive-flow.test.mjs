/**
 * Unit tests for js/receive-flow.js — covers attach() wiring, the
 * add-vs-replace routing in handleEncryptedFile, and the file-type
 * discrimination in decryptIncomingFile. WebRTC, scribe, and the DOM are
 * stubbed; this exercises the pure pipeline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/receive-flow.js');
const moduleSource = readFileSync(modulePath, 'utf8');

function makeFakeKey() { return { __fake: 'key' }; }

function loadIntoJsdom({ decryptResult } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'http://localhost/',
    });
    const win = dom.window;
    win.URL.createObjectURL = () => 'blob:test/abc';
    win.URL.revokeObjectURL = () => {};

    win.WebSendCrypto = {
        decryptWithMetadata: async () => decryptResult || {
            metadata: { name: 'photo.jpg', mimeType: 'image/jpeg', originalSize: 100 },
            data: new ArrayBuffer(8),
        },
        sha256Hex: async () => 'deadbeef',
    };
    win.Protocol = {
        build: {
            fileAck: (h) => ({ type: 'file-ack', hash: h }),
            fileNack: (m) => ({ type: 'file-nack', message: m }),
        },
    };
    win.Collections = {
        getActive: () => ({ id: 1, images: [] }),
        setName: () => {},
        addReceivedFile: () => {},
    };
    win.ReceiveCard = {
        setCardImage: () => {},
        makeSafeBlobUrl: () => 'blob:test/safe',
        SAFE_BLOB_TYPE: 'application/octet-stream',
    };
    win.ReceiveExport = { preloadClientZip: () => {} };
    win.BgOcr = { queue: () => {}, cancel: () => {} };

    win.eval(moduleSource);
    return win;
}

function makeDeps(overrides = {}) {
    const sent = [];
    const photoCount = { v: 0 };
    return {
        sent, photoCount,
        opts: {
            receivedImagesRef: overrides.receivedImages || [],
            getRtc: () => ({ sendMessage: (m) => sent.push(m) }),
            logger: { info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
            i18n: { t: (k) => k },
            showToast: () => {},
            getSharedKey: () => makeFakeKey(),
            getPendingReplaceHash: overrides.getPendingReplaceHash || (() => null),
            setPendingReplaceHash: overrides.setPendingReplaceHash || (() => {}),
            getConnectionTimestamp: () => 1700000000,
            incrementPhotoCount: () => { photoCount.v++; },
            finalizeReceiveStats: () => {},
            updateExportButton: () => {},
            ...overrides.optsExtra,
        },
    };
}

test('exposes ReceiveFlow API', () => {
    const win = loadIntoJsdom();
    assert.equal(typeof win.ReceiveFlow.attach, 'function');
    assert.equal(typeof win.ReceiveFlow.handleEncryptedFile, 'function');
    assert.equal(typeof win.ReceiveFlow.decryptIncomingFile, 'function');
});

test('decryptIncomingFile classifies image/jpeg as fileType=image', async () => {
    const win = loadIntoJsdom({
        decryptResult: {
            metadata: { name: 'a.jpg', mimeType: 'image/jpeg', originalSize: 1 },
            data: new ArrayBuffer(4),
        },
    });
    const { opts } = makeDeps();
    win.ReceiveFlow.attach(opts);
    const fakeBlob = { arrayBuffer: async () => new ArrayBuffer(0) };
    const decoded = await win.ReceiveFlow.decryptIncomingFile(fakeBlob);
    assert.equal(decoded.fileType, 'image');
    assert.equal(decoded.fileMimeType, 'image/jpeg');
    assert.equal(decoded.fileName, 'a.jpg');
});

test('decryptIncomingFile classifies application/pdf as fileType=pdf', async () => {
    const win = loadIntoJsdom({
        decryptResult: {
            metadata: { name: 'doc.pdf', mimeType: 'application/pdf', originalSize: 1 },
            data: new ArrayBuffer(4),
        },
    });
    const { opts } = makeDeps();
    win.ReceiveFlow.attach(opts);
    const decoded = await win.ReceiveFlow.decryptIncomingFile({ arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(decoded.fileType, 'pdf');
});

test('sanitizeMetadataName strips Unicode bidi/format chars (filename-extension spoof defense)', async () => {
    // A hostile peer can send a filename with U+202E (RIGHT-TO-LEFT
    // OVERRIDE) so the displayed text reverses around it, presenting
    // "harmless‮gpj.exe" as "harmlessexe.jpg" on the receive card.
    // The sanitiser must drop all bidi/format/zero-width chars before
    // either display or downstream filename use.
    const spoof = 'harmless' + '‮' + 'gpj.exe';
    const win = loadIntoJsdom({
        decryptResult: {
            metadata: { name: spoof, mimeType: 'application/octet-stream', originalSize: 1 },
            data: new ArrayBuffer(4),
        },
    });
    const { opts } = makeDeps();
    win.ReceiveFlow.attach(opts);
    const decoded = await win.ReceiveFlow.decryptIncomingFile({ arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(decoded.fileName.includes('‮'), false,
        'RLO must be stripped');
    assert.equal(decoded.fileName, 'harmlessgpj.exe',
        'sanitised name should be the literal characters minus the bidi control');
});

test('sanitizeMetadataName strips zero-width and other bidi controls', async () => {
    // ZWSP + LRO + RLI + BOM + WJ in a single name
    const spoof = 'a​' + 'b‭' + 'c⁧' + 'd﻿' + 'e⁠' + 'f.txt';
    const win = loadIntoJsdom({
        decryptResult: {
            metadata: { name: spoof, mimeType: 'text/plain', originalSize: 1 },
            data: new ArrayBuffer(4),
        },
    });
    const { opts } = makeDeps();
    win.ReceiveFlow.attach(opts);
    const decoded = await win.ReceiveFlow.decryptIncomingFile({ arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(decoded.fileName, 'abcdef.txt');
});

test('sanitizeMimeType: malformed peer mimeType collapses to octet-stream', async () => {
    // Peer-supplied junk with HTML-like chars must NOT round-trip into
    // the receiver pipeline. We accept only RFC-token-shaped types.
    const win = loadIntoJsdom({
        decryptResult: {
            metadata: { name: 'a', mimeType: 'image/png<script>alert(1)</script>', originalSize: 1 },
            data: new ArrayBuffer(4),
        },
    });
    const { opts } = makeDeps();
    win.ReceiveFlow.attach(opts);
    const decoded = await win.ReceiveFlow.decryptIncomingFile({ arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(decoded.fileMimeType, 'application/octet-stream',
        'unsafe mime falls back to octet-stream');
    assert.equal(decoded.fileType, 'other');
});

test('sanitizeMimeType: mimeType length is bounded', async () => {
    const win = loadIntoJsdom({
        decryptResult: {
            metadata: { name: '', mimeType: 'a/' + 'b'.repeat(500), originalSize: 1 },
            data: new ArrayBuffer(4),
        },
    });
    const { opts } = makeDeps();
    win.ReceiveFlow.attach(opts);
    const decoded = await win.ReceiveFlow.decryptIncomingFile({ arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(decoded.fileMimeType, 'application/octet-stream');
});

test('safeExtFromMime: ext is bounded to ≤8 alnum chars', async () => {
    const win = loadIntoJsdom({
        decryptResult: {
            metadata: { name: '', mimeType: 'application/x-some-very-long-subtype', originalSize: 1 },
            data: new ArrayBuffer(4),
        },
    });
    const { opts } = makeDeps();
    win.ReceiveFlow.attach(opts);
    const decoded = await win.ReceiveFlow.decryptIncomingFile({ arrayBuffer: async () => new ArrayBuffer(0) });
    const tail = decoded.fileName.split('.').pop();
    assert.ok(tail.length <= 8, `ext should be ≤8 chars, got "${tail}"`);
    assert.match(tail, /^[a-z0-9]+$/i, 'ext should be alnum only');
});

test('decryptIncomingFile classifies generic mime as fileType=other and synthesizes a filename', async () => {
    const win = loadIntoJsdom({
        decryptResult: {
            metadata: { name: '', mimeType: 'application/zip', originalSize: 1 },
            data: new ArrayBuffer(4),
        },
    });
    const { opts } = makeDeps();
    win.ReceiveFlow.attach(opts);
    const decoded = await win.ReceiveFlow.decryptIncomingFile({ arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(decoded.fileType, 'other');
    assert.match(decoded.fileName, /^websend_1700000000_\d+\.zip$/);
});

test('handleEncryptedFile: no pending replace hash → adds new image and acks', async () => {
    const win = loadIntoJsdom();
    const received = [];
    const { opts, sent } = makeDeps({ receivedImages: received });
    win.ReceiveFlow.attach(opts);
    await win.ReceiveFlow.handleEncryptedFile({ blob: { arrayBuffer: async () => new ArrayBuffer(0) } });
    assert.equal(received.length, 1);
    assert.equal(received[0].hash, 'deadbeef');
    assert.deepEqual(sent, [{ type: 'file-ack', hash: 'deadbeef' }]);
});

test('handleEncryptedFile: pending replace hash matches → replaces existing image', async () => {
    const win = loadIntoJsdom();
    const received = [{ hash: 'oldhash', data: new Uint8Array([1]), name: 'old.jpg', mimeType: 'image/jpeg', fileType: 'image' }];
    let pending = 'oldhash';
    const { opts, sent } = makeDeps({
        receivedImages: received,
        getPendingReplaceHash: () => pending,
        setPendingReplaceHash: (h) => { pending = h; },
    });
    win.ReceiveFlow.attach(opts);
    await win.ReceiveFlow.handleEncryptedFile({ blob: { arrayBuffer: async () => new ArrayBuffer(0) } });
    assert.equal(received.length, 1, 'no new image added');
    assert.equal(received[0].hash, 'deadbeef', 'replaced in place with new hash');
    assert.equal(pending, null, 'pending hash cleared');
    assert.deepEqual(sent, [{ type: 'file-ack', hash: 'deadbeef' }]);
});

test('handleEncryptedFile: pending hash but no match → falls back to new image', async () => {
    const win = loadIntoJsdom();
    const received = [{ hash: 'something-else' }];
    let pending = 'wronghash';
    const { opts } = makeDeps({
        receivedImages: received,
        getPendingReplaceHash: () => pending,
        setPendingReplaceHash: (h) => { pending = h; },
    });
    win.ReceiveFlow.attach(opts);
    await win.ReceiveFlow.handleEncryptedFile({ blob: { arrayBuffer: async () => new ArrayBuffer(0) } });
    assert.equal(received.length, 2, 'fell back to add');
    assert.equal(pending, null);
});

test('handleEncryptedFile: missing sharedKey aborts without crash', async () => {
    const win = loadIntoJsdom();
    const { opts } = makeDeps();
    opts.getSharedKey = () => null;
    win.ReceiveFlow.attach(opts);
    await win.ReceiveFlow.handleEncryptedFile({ blob: { arrayBuffer: async () => new ArrayBuffer(0) } });
    // No throw, no calls into rtc — implicit assertion.
});

test('handleEncryptedFile: decryption failure sends generic file-nack (no message leak)', async () => {
    const win = loadIntoJsdom();
    // Specific internal error string MUST NOT round-trip back to the
    // peer — that would let a hostile sender oracle-probe the crypto
    // layer (tag-fail vs IV-len vs JSON-parse vs missing-key).
    win.WebSendCrypto.decryptWithMetadata = async () => { throw new Error('AES-GCM tag check failed at offset 7'); };
    const { opts, sent } = makeDeps();
    win.ReceiveFlow.attach(opts);
    await win.ReceiveFlow.handleEncryptedFile({ blob: { arrayBuffer: async () => new ArrayBuffer(0) } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'file-nack');
    assert.equal(sent[0].message, 'decrypt-failed',
        'peer-facing reason must be a constant, not the raw error message');
});
