/**
 * Unit tests for js/receive-flow.js: covers attach() wiring, the v2
 * chunked-transfer pipeline (file-start / file-segment / file-end),
 * metadata sanitisation and file-type discrimination, the add-vs-replace
 * routing at file-end, and resume state. WebRTC, SegmentStream, and the
 * DOM are stubbed; this exercises the pure pipeline.
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

function loadIntoJsdom() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'http://localhost/',
    });
    const win = dom.window;
    win.URL.createObjectURL = () => 'blob:test/abc';
    win.URL.revokeObjectURL = () => {};

    win.Protocol = {
        build: {
            fileAck: (h) => ({ type: 'file-ack', hash: h }),
            fileNack: (m) => ({ type: 'file-nack', message: m }),
            segmentNack: (seq) => ({ type: 'segment-nack', seq }),
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
    assert.equal(typeof win.ReceiveFlow.handleFileStart, 'function');
    assert.equal(typeof win.ReceiveFlow.handleFileSegment, 'function');
    assert.equal(typeof win.ReceiveFlow.handleFileEnd, 'function');
    assert.equal(typeof win.ReceiveFlow.getResumeState, 'function');
    assert.equal(typeof win.ReceiveFlow.applyResumeAck, 'function');
});

// ---- v2 chunked transfers (file-start / file-segment / file-end) ----

const COMPOSITE = 'c0'.repeat(32);

/**
 * Fake SegmentReceiver with scriptable accept(); mirrors the real API
 * surface that receive-flow touches.
 */
function makeFakeReceiver({ segCount = 2, acceptImpl, content } = {}) {
    const calls = [];
    let nextSeq = 0;
    return {
        calls,
        segCount,
        get nextSeq() { return nextSeq; },
        async accept(seq, ct) {
            calls.push(seq);
            if (acceptImpl) return acceptImpl(seq, ct);
            nextSeq = seq + 1;
            return { ok: true, isLast: seq === segCount };
        },
        async finish() {
            return {
                metadata: { name: 'big.bin', mimeType: 'application/octet-stream', originalSize: 8 },
                blob: { arrayBuffer: async () => (content || new ArrayBuffer(8)) },
                compositeHashHex: COMPOSITE,
            };
        },
    };
}

function setupV2(fakeReceiver, overrides = {}) {
    const win = loadIntoJsdom();
    const createdWith = [];
    win.SegmentStream = {
        createReceiver: (opts) => { createdWith.push(opts); return fakeReceiver; },
    };
    const deps = makeDeps({
        ...overrides,
        optsExtra: {
            getSessionKeys: () => ({ deriveFileKey: async () => ({ __fake: 'filekey' }) }),
            ...(overrides.optsExtra || {}),
        },
    });
    win.ReceiveFlow.attach(deps.opts);
    return { win, deps, createdWith };
}

const V2_START = { type: 'file-start', v: 2, segSize: 262144, segCount: 2, salt: 'A'.repeat(22) + '==' };

test('v2 happy path: segments verify, file is displayed, ack carries the composite hash', async () => {
    const images = [];
    const fake = makeFakeReceiver({ segCount: 2 });
    const { win, deps, createdWith } = setupV2(fake, { receivedImages: images });

    await win.ReceiveFlow.handleFileStart(V2_START);
    assert.equal(createdWith.length, 1);
    assert.equal(createdWith[0].segCount, 2);
    assert.equal(createdWith[0].saltB64, V2_START.salt);

    for (let seq = 0; seq <= 2; seq++) {
        await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq, ct: new ArrayBuffer(32) });
    }
    await win.ReceiveFlow.handleFileEnd({ type: 'file-end' });

    assert.deepEqual(fake.calls, [0, 1, 2]);
    assert.equal(images.length, 1);
    assert.equal(images[0].hash, COMPOSITE,
        'the gallery identity hash must be the composite hash, not a recomputed sha256');
    const ack = deps.sent.find(m => m.type === 'file-ack');
    assert.equal(ack.hash, COMPOSITE);
});

test('v2 segment rejection sends segment-nack once and drops later segments', async () => {
    const fake = makeFakeReceiver({
        acceptImpl: (seq) => (seq === 1 ? { ok: false, reason: 'auth' } : { ok: true, isLast: false }),
    });
    const { win, deps } = setupV2(fake);

    await win.ReceiveFlow.handleFileStart(V2_START);
    for (let seq = 0; seq <= 2; seq++) {
        await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq, ct: new ArrayBuffer(32) });
    }
    assert.deepEqual(fake.calls, [0, 1],
        'while waiting for the rewind, segment 2 must not reach accept()');
    const nacks = deps.sent.filter(m => m.type === 'segment-nack');
    assert.deepEqual(nacks.map(n => n.seq), [fake.nextSeq],
        'one nack naming the first record we lack');
    assert.equal(deps.sent.filter(m => m.type === 'file-nack').length, 0,
        'a single bad record must not fail the whole transfer any more');
});

test('v2 file-end with missing records requests a rewind instead of failing', async () => {
    const fake = makeFakeReceiver({ segCount: 5 }); // only 2 records will arrive
    const { win, deps } = setupV2(fake);

    await win.ReceiveFlow.handleFileStart(V2_START);
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 0, ct: new ArrayBuffer(32) });
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 1, ct: new ArrayBuffer(32) });
    await win.ReceiveFlow.handleFileEnd({ type: 'file-end' });

    const nacks = deps.sent.filter(m => m.type === 'segment-nack');
    assert.deepEqual(nacks.map(n => n.seq), [2]);
    assert.equal(deps.sent.filter(m => m.type === 'file-nack').length, 0);
    assert.ok(await win.ReceiveFlow.getResumeState(),
        'the transfer must stay alive across the retry');
});

test('v2 matching segment-rewind re-keys and the retried tail completes', async () => {
    const images = [];
    let failOnce = true;
    const rekeys = [];
    let nextSeq = 0;
    const calls = [];
    const receiver = {
        calls,
        segCount: 2,
        get nextSeq() { return nextSeq; },
        async accept(seq) {
            calls.push(seq);
            if (seq === 1 && failOnce) { failOnce = false; return { ok: false, reason: 'auth' }; }
            nextSeq = seq + 1;
            return { ok: true, isLast: seq === 2 };
        },
        rekey(saltB64, fromSeq) { rekeys.push({ saltB64, fromSeq }); nextSeq = fromSeq; },
        finish: makeFakeReceiver().finish,
    };
    const { win, deps } = setupV2(receiver, { receivedImages: images });
    const SALT2 = 'B'.repeat(22) + '==';

    await win.ReceiveFlow.handleFileStart(V2_START);
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 0, ct: new ArrayBuffer(32) });
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 1, ct: new ArrayBuffer(32) }); // fails
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 2, ct: new ArrayBuffer(32) }); // dropped
    await win.ReceiveFlow.handleFileEnd({ type: 'file-end' }); // dropped (awaiting rewind)
    assert.equal(images.length, 0, 'the stale file-end must not finish the file');

    await win.ReceiveFlow.handleSegmentRewind({ type: 'segment-rewind', seq: 1, salt: SALT2 });
    assert.deepEqual(rekeys, [{ saltB64: SALT2, fromSeq: 1 }]);

    // Sender resends the tail under the new salt, then a fresh file-end.
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 1, ct: new ArrayBuffer(32) });
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 2, ct: new ArrayBuffer(32) });
    await win.ReceiveFlow.handleFileEnd({ type: 'file-end' });

    assert.deepEqual(calls, [0, 1, 1, 2], 'records resent after the rewind reach accept()');
    assert.equal(images.length, 1, 'the healed transfer completes');
    const ack = deps.sent.find(m => m.type === 'file-ack');
    assert.equal(ack.hash, COMPOSITE);
});

test('v2 unsolicited segment-rewind is ignored (no re-key, no replay)', async () => {
    const rekeys = [];
    const fake = makeFakeReceiver({ segCount: 5 });
    fake.rekey = (saltB64, fromSeq) => rekeys.push({ saltB64, fromSeq });
    const { win } = setupV2(fake);

    await win.ReceiveFlow.handleFileStart(V2_START);
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 0, ct: new ArrayBuffer(32) });
    await win.ReceiveFlow.handleSegmentRewind({ type: 'segment-rewind', seq: 0, salt: 'B'.repeat(22) + '==' });
    assert.deepEqual(rekeys, [], 'only a rewind answering our own nack may re-key');
});

test('v2 retry budget exhaustion file-nacks with the last failure class', async () => {
    const fake = makeFakeReceiver({
        segCount: 2,
        acceptImpl: () => ({ ok: false, reason: 'auth' }), // every pass fails
    });
    fake.rekey = () => {};
    const { win, deps } = setupV2(fake);
    const SALT2 = 'B'.repeat(22) + '==';

    await win.ReceiveFlow.handleFileStart(V2_START);
    for (let round = 0; round < 4; round++) {
        await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 0, ct: new ArrayBuffer(32) });
        if (round < 3) {
            await win.ReceiveFlow.handleSegmentRewind({ type: 'segment-rewind', seq: 0, salt: SALT2 });
        }
    }
    const segNacks = deps.sent.filter(m => m.type === 'segment-nack');
    assert.equal(segNacks.length, 3, 'three retries were attempted');
    const nacks = deps.sent.filter(m => m.type === 'file-nack');
    assert.equal(nacks.length, 1, 'the fourth failure gives up');
    assert.equal(nacks[0].message, 'decrypt-failed');
    assert.equal(await win.ReceiveFlow.getResumeState(), null, 'the transfer is dead');
});

test('v2 segments are processed strictly in order even with slow accepts', async () => {
    const order = [];
    let seq0Done = false;
    const fake = makeFakeReceiver({
        acceptImpl: async (seq) => {
            order.push(`start-${seq}`);
            if (seq === 0) {
                await new Promise(r => setTimeout(r, 20)); // slow first segment
                seq0Done = true;
            } else {
                assert.equal(seq0Done, true, 'segment 1 must not start before segment 0 finished');
            }
            order.push(`end-${seq}`);
            return { ok: true, isLast: false };
        },
    });
    const { win } = setupV2(fake);

    await win.ReceiveFlow.handleFileStart(V2_START);
    // Fire both without awaiting, like the parser does within one chunk.
    const p0 = win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 0, ct: new ArrayBuffer(32) });
    const p1 = win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 1, ct: new ArrayBuffer(32) });
    await Promise.all([p0, p1]);
    assert.deepEqual(order, ['start-0', 'end-0', 'start-1', 'end-1']);
});

test('v2 file-start without session keys is ignored; later segments are no-ops', async () => {
    const fake = makeFakeReceiver();
    const { win, deps, createdWith } = setupV2(fake, {
        optsExtra: { getSessionKeys: () => null },
    });
    await win.ReceiveFlow.handleFileStart(V2_START);
    assert.equal(createdWith.length, 0);
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 0, ct: new ArrayBuffer(32) });
    assert.equal(fake.calls.length, 0);
    assert.equal(deps.sent.length, 0, 'no nack spam for gated/ignored transfers');
});

test('v2 resume: getResumeState reports the missing seq, applyResumeAck rekeys', async () => {
    const rekeys = [];
    const fake = makeFakeReceiver({ segCount: 5 });
    fake.rekey = (saltB64, fromSeq) => rekeys.push({ saltB64, fromSeq });
    const { win } = setupV2(fake);

    assert.equal(await win.ReceiveFlow.getResumeState(), null,
        'no transfer in flight means nothing to offer');

    await win.ReceiveFlow.handleFileStart(V2_START);
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 0, ct: new ArrayBuffer(32) });
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 1, ct: new ArrayBuffer(32) });

    // Field-wise compare: the state objects come from the jsdom realm,
    // whose Object.prototype differs from this realm's (deepStrictEqual
    // compares prototypes).
    const offer = await win.ReceiveFlow.getResumeState();
    assert.equal(offer.nextSeq, 2, 'the resume offer must name the first record we are missing');
    assert.equal(offer.segCount, 5);

    const newSalt = 'B'.repeat(22) + '==';
    const st = await win.ReceiveFlow.applyResumeAck(2, newSalt);
    assert.equal(st.segCount, 5, 'ack handling returns what the parser re-arm needs');
    assert.deepEqual(rekeys, [{ saltB64: newSalt, fromSeq: 2 }],
        'the fresh salt must be applied before resent records arrive');
});

test('v2 abandonTransfer drops the in-flight receiver without nacking', async () => {
    const fake = makeFakeReceiver({ segCount: 5 });
    const { win, deps } = setupV2(fake);

    await win.ReceiveFlow.handleFileStart(V2_START);
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 0, ct: new ArrayBuffer(32) });
    await win.ReceiveFlow.abandonTransfer();

    assert.equal(await win.ReceiveFlow.getResumeState(), null);
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 1, ct: new ArrayBuffer(32) });
    assert.deepEqual(fake.calls, [0], 'segments after the abandon are dropped in O(1)');
    assert.equal(deps.sent.filter(m => m.type === 'file-nack').length, 0,
        'a sender-requested restart is not an error; no nack');
});

test('v2 applyResumeAck with no transfer in flight resolves null and does not throw', async () => {
    const { win } = setupV2(makeFakeReceiver());
    assert.equal(await win.ReceiveFlow.applyResumeAck(2, 'B'.repeat(22) + '=='), null);
});

test('v1 file-start is nacked with unsupported-version', async () => {
    const fake = makeFakeReceiver();
    const { win, deps, createdWith } = setupV2(fake);
    await win.ReceiveFlow.handleFileStart({ type: 'file-start', size: 262144 });
    assert.equal(createdWith.length, 0, 'no receiver may be created for an unknown format');
    const nacks = deps.sent.filter(m => m.type === 'file-nack');
    assert.equal(nacks.length, 1);
    assert.equal(nacks[0].message, 'unsupported-version');
});

test('future-version file-start is nacked with unsupported-version', async () => {
    const { win, deps } = setupV2(makeFakeReceiver());
    await win.ReceiveFlow.handleFileStart({ type: 'file-start', v: 3, blocks: 9 });
    const nacks = deps.sent.filter(m => m.type === 'file-nack');
    assert.equal(nacks.length, 1);
    assert.equal(nacks[0].message, 'unsupported-version');
});

// ---- metadata sanitisation and file-type discrimination ----
//
// The decrypted metadata is fully sender-controlled; these route a
// one-segment transfer through the v2 pipeline with finish() yielding
// hostile metadata and assert on what lands in the gallery.

/**
 * Run a complete one-segment v2 transfer whose finish() yields the given
 * metadata; returns the resulting gallery entry.
 */
async function receiveWithMetadata(metadata) {
    const images = [];
    const fake = makeFakeReceiver({ segCount: 1 });
    fake.finish = async () => ({
        metadata,
        blob: { arrayBuffer: async () => new ArrayBuffer(4) },
        compositeHashHex: COMPOSITE,
    });
    const { win } = setupV2(fake, { receivedImages: images });
    await win.ReceiveFlow.handleFileStart({ ...V2_START, segCount: 1 });
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 0, ct: new ArrayBuffer(32) });
    await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq: 1, ct: new ArrayBuffer(32) });
    await win.ReceiveFlow.handleFileEnd({ type: 'file-end' });
    assert.equal(images.length, 1, 'the transfer must complete and display');
    return images[0];
}

test('image/jpeg metadata is classified as fileType=image', async () => {
    const img = await receiveWithMetadata({ name: 'a.jpg', mimeType: 'image/jpeg', originalSize: 1 });
    assert.equal(img.fileType, 'image');
    assert.equal(img.mimeType, 'image/jpeg');
    assert.equal(img.name, 'a.jpg');
});

test('application/pdf metadata is classified as fileType=pdf', async () => {
    const img = await receiveWithMetadata({ name: 'doc.pdf', mimeType: 'application/pdf', originalSize: 1 });
    assert.equal(img.fileType, 'pdf');
});

test('sanitizeMetadataName strips Unicode bidi/format chars (filename-extension spoof defense)', async () => {
    // A hostile peer can send a filename with U+202E (RIGHT-TO-LEFT
    // OVERRIDE) so the displayed text reverses around it, presenting
    // "harmless‮gpj.exe" as "harmlessexe.jpg" on the receive card.
    // The sanitiser must drop all bidi/format/zero-width chars before
    // either display or downstream filename use.
    const spoof = 'harmless' + '‮' + 'gpj.exe';
    const img = await receiveWithMetadata({ name: spoof, mimeType: 'application/octet-stream', originalSize: 1 });
    assert.equal(img.name.includes('‮'), false, 'RLO must be stripped');
    assert.equal(img.name, 'harmlessgpj.exe',
        'sanitised name should be the literal characters minus the bidi control');
});

test('sanitizeMetadataName strips zero-width and other bidi controls', async () => {
    // ZWSP + LRO + RLI + BOM + WJ in a single name
    const spoof = 'a​' + 'b‭' + 'c⁧' + 'd﻿' + 'e⁠' + 'f.txt';
    const img = await receiveWithMetadata({ name: spoof, mimeType: 'text/plain', originalSize: 1 });
    assert.equal(img.name, 'abcdef.txt');
});

test('sanitizeMimeType: malformed peer mimeType collapses to octet-stream', async () => {
    // Peer-supplied junk with HTML-like chars must NOT round-trip into
    // the receiver pipeline. We accept only RFC-token-shaped types.
    const img = await receiveWithMetadata({
        name: 'a', mimeType: 'image/png<script>alert(1)</script>', originalSize: 1,
    });
    assert.equal(img.mimeType, 'application/octet-stream',
        'unsafe mime falls back to octet-stream');
    assert.equal(img.fileType, 'other');
});

test('sanitizeMimeType: mimeType length is bounded', async () => {
    const img = await receiveWithMetadata({ name: '', mimeType: 'a/' + 'b'.repeat(500), originalSize: 1 });
    assert.equal(img.mimeType, 'application/octet-stream');
});

test('safeExtFromMime: ext is bounded to ≤8 alnum chars', async () => {
    const img = await receiveWithMetadata({ name: '', mimeType: 'application/x-some-very-long-subtype', originalSize: 1 });
    const tail = img.name.split('.').pop();
    assert.ok(tail.length <= 8, `ext should be ≤8 chars, got "${tail}"`);
    assert.match(tail, /^[a-z0-9]+$/i, 'ext should be alnum only');
});

test('generic mime is classified as fileType=other and a filename is synthesized', async () => {
    const img = await receiveWithMetadata({ name: '', mimeType: 'application/zip', originalSize: 1 });
    assert.equal(img.fileType, 'other');
    assert.match(img.name, /^websend_1700000000_\d+\.zip$/);
});

// ---- add-vs-replace routing at file-end ----

async function runFullTransfer(win) {
    await win.ReceiveFlow.handleFileStart(V2_START);
    for (let seq = 0; seq <= 2; seq++) {
        await win.ReceiveFlow.handleFileSegment({ type: 'file-segment', seq, ct: new ArrayBuffer(32) });
    }
    await win.ReceiveFlow.handleFileEnd({ type: 'file-end' });
}

test('file-end with matching pending replace hash replaces the image in place', async () => {
    const received = [{ hash: 'oldhash', data: new Uint8Array([1]), name: 'old.jpg', mimeType: 'image/jpeg', fileType: 'image' }];
    let pending = 'oldhash';
    const { win, deps } = setupV2(makeFakeReceiver({ segCount: 2 }), {
        receivedImages: received,
        getPendingReplaceHash: () => pending,
        setPendingReplaceHash: (h) => { pending = h; },
    });
    await runFullTransfer(win);
    assert.equal(received.length, 1, 'no new image added');
    assert.equal(received[0].hash, COMPOSITE, 'replaced in place with the new composite hash');
    assert.equal(pending, null, 'pending hash cleared');
    const ack = deps.sent.find(m => m.type === 'file-ack');
    assert.equal(ack.hash, COMPOSITE);
});

test('file-end with a stale pending replace hash falls back to adding a new image', async () => {
    const received = [{ hash: 'something-else' }];
    let pending = 'wronghash';
    const { win } = setupV2(makeFakeReceiver({ segCount: 2 }), {
        receivedImages: received,
        getPendingReplaceHash: () => pending,
        setPendingReplaceHash: (h) => { pending = h; },
    });
    await runFullTransfer(win);
    assert.equal(received.length, 2, 'fell back to add');
    assert.equal(pending, null);
});
