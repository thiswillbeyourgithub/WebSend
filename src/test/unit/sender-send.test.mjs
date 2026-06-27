/**
 * Unit tests for js/sender-send.js, focused on the verification gate
 * around the drain loop. When isVerified() is false the loop pauses
 * with the queue intact (files picked while the transport was down
 * must survive a reconnect, not be dropped) and no bytes leave the
 * host; once verification completes, a fresh drain() sends everything
 * that was queued. This catches both a plaintext leak (sending while
 * unverified) and the "file refused while reconnecting" regression.
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

    const sentFiles = [];   // [{sender, resumeFromSeq}] per rtc.sendFile call
    const sentMessages = [];
    const created = [];     // createSender args, to assert metadata/keys wiring
    const rewinds = [];     // seqs passed to fakeSender.rewind

    // Fake SegmentStream: sender-send only drives the SegmentSender
    // lifecycle (create once, rewind on resume, finishHash after ack);
    // the real record crypto is covered by segment-stream.test.mjs.
    function makeFakeSegmentSender() {
        let nextSeq = 0;
        return {
            segCount: 3,
            get nextSeq() { return nextSeq; },
            saltB64: 'A'.repeat(22) + '==',
            estimatedWireSize: 4096,
            estimateWireOffset: (seq) => seq * 1024,
            _advance(seq) { nextSeq = seq; },
            rewind: async (seq) => {
                rewinds.push(seq);
                nextSeq = seq;
                return { saltB64: 'B'.repeat(22) + '==' };
            },
            finishHash: async () => 'deadbeef',
        };
    }
    win.SegmentStream = {
        createSender: async (opts) => {
            created.push(opts);
            return makeFakeSegmentSender();
        },
    };
    win.Protocol = {
        MAX_FILE_SIZE: 4 * 1024 * 1024 * 1024,
        build: {
            replaceImage: (h) => ({ type: 'replace-image', hash: h }),
            batchStart: () => ({ type: 'batch-start' }),
            batchEnd: () => ({ type: 'batch-end' }),
            fileResumeAckV2: (nextSeq, salt) => (salt === undefined
                ? { type: 'file-resume-ack', nextSeq }
                : { type: 'file-resume-ack', nextSeq, salt }),
        },
    };
    win.formatRate = () => '0 kB/s';
    win.formatTransferStats = () => '';
    win.createRateTracker = () => ({ update: () => 0 });

    const fakeRtc = {
        sendMessage: (m) => sentMessages.push(m),
        sendFile: async (sender, onProgress, resumeFromSeq) => {
            sentFiles.push({ sender, resumeFromSeq });
        },
    };

    const logs = { info: [], warn: [], error: [], success: [] };
    const toasts = [];
    let isVerifiedNow = verified;
    const deps = {
        getRtc: () => fakeRtc,
        getSessionKeys: () => ({ __fake: 'sessionKeys' }),
        isVerified: () => isVerifiedNow,
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
    return {
        win, fakeRtc, sentFiles, sentMessages, created, rewinds, logs, toasts,
        setVerified: (v) => { isVerifiedNow = v; },
    };
}

function makeBlob(win) {
    return new win.Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
}

test('drain pauses while peer is not verified, keeping the queue, and resumes once verified', async () => {
    const { win, sentFiles, logs, setVerified } = loadIntoJsdom({ verified: false });
    win.SenderSend.push({ blob: makeBlob(win) });
    await win.SenderSend.drain();
    assert.equal(sentFiles.length, 0, 'no file bytes should leave the host');
    assert.equal(win.SenderSend.size(), 1,
        'a file queued while unverified (e.g. mid-reconnect) must survive, not be refused');
    assert.ok(
        logs.info.some(m => /paused.*not verified/i.test(m)),
        `info log should mention the pause, got: ${JSON.stringify(logs.info)}`
    );

    // Verification completes (reconnect handshake done): a fresh drain
    // flushes the queue.
    setVerified(true);
    await win.SenderSend.drain();
    assert.equal(sentFiles.length, 1, 'the queued file goes out after verification');
    assert.equal(win.SenderSend.size(), 0);
});

test('batch-start marked while unverified is sent right before the first item after verification', async () => {
    const { win, sentFiles, sentMessages, setVerified } = loadIntoJsdom({ verified: false });
    win.SenderSend.markBatchStartPending();
    win.SenderSend.markBatchEndPending();
    win.SenderSend.push({ blob: makeBlob(win) });
    await win.SenderSend.drain();
    assert.equal(sentMessages.length, 0, 'no control message goes out while unverified');

    setVerified(true);
    await win.SenderSend.drain();
    assert.deepEqual(sentMessages.map(m => m.type), ['batch-start', 'batch-end'],
        'the deferred batch-start must open the batch and batch-end close it');
    assert.equal(sentFiles.length, 1);
});

test('resetForReconnect keeps queued blobs but rebuilds session-bound SegmentSenders', async () => {
    const { win, fakeRtc, sentFiles, created } = loadIntoJsdom({ verified: true });
    let calls = 0;
    fakeRtc.sendFile = async (sender, onProgress, resumeFromSeq) => {
        sentFiles.push({ sender, resumeFromSeq });
        if (++calls === 1) {
            const e = new Error('drop');
            e.transient = true;
            throw e;
        }
    };
    win.SenderSend.push({ blob: makeBlob(win) });
    await win.SenderSend.drain();
    assert.equal(win.SenderSend.size(), 1, 'transient drop pauses with the item kept');

    // Full reconnect: new session keys, the old SegmentSender (and the
    // transient pause) are unusable; the blob itself must survive.
    win.SenderSend.resetForReconnect();
    await win.SenderSend.drain();
    assert.equal(sentFiles.length, 2, 'the kept blob is re-sent after the reconnect');
    assert.equal(created.length, 2,
        'a fresh SegmentSender (re-keyed with the new sessionKeys) must be built');
    assert.notEqual(sentFiles[1].sender, sentFiles[0].sender);
    assert.equal(sentFiles[1].resumeFromSeq, undefined, 'fresh send from record 0, not a resume');
    assert.equal(win.SenderSend.size(), 0);
});

test('sendOnePhoto transmits when peer is verified', async () => {
    const { win, sentFiles, created } = loadIntoJsdom({ verified: true });
    win.SenderSend.push({ blob: makeBlob(win) });
    await win.SenderSend.drain();
    assert.equal(sentFiles.length, 1, 'exactly one segment stream should be sent');
    assert.equal(created.length, 1, 'one SegmentSender per file');
    assert.equal(created[0].metadata.mimeType, 'image/png');
    assert.equal(created[0].metadata.originalSize, 4);
    assert.deepEqual(created[0].sessionKeys, { __fake: 'sessionKeys' },
        'the session key handles must reach SegmentStream.createSender');
});

test('a blob over Protocol.MAX_FILE_SIZE is refused with the fileTooLarge toast', async () => {
    const { win, sentFiles, created, toasts } = loadIntoJsdom({ verified: true });
    // Shrink the cap instead of allocating a >4 GiB blob in the test.
    win.Protocol.MAX_FILE_SIZE = 2;
    win.SenderSend.push({ blob: makeBlob(win) }); // 4 bytes > 2
    await win.SenderSend.drain();
    assert.equal(created.length, 0, 'no SegmentSender may be created for an oversized blob');
    assert.equal(sentFiles.length, 0, 'nothing reaches the wire');
    assert.ok(toasts.includes('send.fileTooLarge'),
        `the user must learn why the send failed, got toasts: ${JSON.stringify(toasts)}`);
    assert.equal(win.SenderSend.size(), 0, 'the oversized item leaves the queue (no retry loop)');
});

test('transient drop pauses the queue; resume-offer rewinds before acking and resumes from seq', async () => {
    const { win, fakeRtc, sentFiles, sentMessages, rewinds } = loadIntoJsdom({ verified: true });

    // First attempt drops mid-transfer with a tagged transient error.
    let calls = 0;
    fakeRtc.sendFile = async (sender, onProgress, resumeFromSeq) => {
        sentFiles.push({ sender, resumeFromSeq });
        if (++calls === 1) {
            sender._advance(2);
            const e = new Error('drop');
            e.transient = true;
            e.nextSeq = 2;
            throw e;
        }
    };

    const item = { blob: makeBlob(win) };
    win.SenderSend.push(item);
    await win.SenderSend.drain();
    assert.equal(sentFiles.length, 1, 'first attempt went out');
    assert.equal(win.SenderSend.size(), 1, 'queue head must survive a transient drop');

    // Receiver offers to resume from record 2 after reconnect.
    await win.SenderSend.handleResumeOffer({ type: 'file-resume-offer', nextSeq: 2 });
    // Wait for the one-shot resume drain to finish.
    await new Promise(r => setTimeout(r, 0));

    assert.deepEqual(rewinds, [2], 'the SegmentSender must be rewound to the offered seq');
    const ack = sentMessages.find(m => m.type === 'file-resume-ack');
    assert.deepEqual(ack, { type: 'file-resume-ack', nextSeq: 2, salt: 'B'.repeat(22) + '==' },
        'the ack must carry the fresh salt from the rewind');
    assert.equal(sentFiles.length, 2, 'the transfer resumes');
    assert.equal(sentFiles[1].resumeFromSeq, 2);
    assert.equal(sentFiles[1].sender, sentFiles[0].sender,
        'the same SegmentSender (same digests) must be reused on resume');
    assert.equal(win.SenderSend.size(), 0, 'item leaves the queue after the resumed send acks');
});

test('resume-offer the head cannot match is answered with nextSeq=0 and a fresh drain', async () => {
    const { win, fakeRtc, sentFiles, sentMessages, rewinds } = loadIntoJsdom({ verified: true });

    let calls = 0;
    fakeRtc.sendFile = async (sender, onProgress, resumeFromSeq) => {
        sentFiles.push({ sender, resumeFromSeq });
        if (++calls === 1) {
            sender._advance(2);
            const e = new Error('drop');
            e.transient = true;
            throw e;
        }
    };

    win.SenderSend.push({ blob: makeBlob(win) });
    await win.SenderSend.drain();

    // Offered seq is out of range for the head (segCount 3 allows <= 4).
    await win.SenderSend.handleResumeOffer({ type: 'file-resume-offer', nextSeq: 9 });
    await new Promise(r => setTimeout(r, 0));

    const ack = sentMessages.find(m => m.type === 'file-resume-ack');
    assert.deepEqual(ack, { type: 'file-resume-ack', nextSeq: 0 });
    assert.equal(sentFiles.length, 2, 'a fresh full send must follow');
    assert.equal(sentFiles[1].resumeFromSeq, undefined, 'fresh send, not a resume');
    assert.deepEqual(rewinds, [0],
        'the advanced sender must be rewound to 0 so the fresh file-start re-keys');
});

test('drain pauses with the queue intact while the transport is disconnected, resumes on reconnect', async () => {
    const { win, fakeRtc, sentFiles, sentMessages, logs } = loadIntoJsdom({ verified: true });
    // Transient relay drop: the session keys are still good (isVerified
    // stays true) but the socket is closed. This is the "picked a file
    // while the WS was down" regression: drain used to push batch-start
    // and the file into the closed socket and fail the file with
    // "finishHash before all segments were read".
    let connected = false;
    fakeRtc.isConnected = () => connected;

    win.SenderSend.markBatchStartPending();
    win.SenderSend.push({ blob: makeBlob(win) });
    await win.SenderSend.drain();

    assert.equal(sentMessages.length, 0, 'no batch-start may be consumed while disconnected');
    assert.equal(sentFiles.length, 0, 'no file bytes reach a closed transport');
    assert.equal(win.SenderSend.size(), 1, 'the file stays queued across the outage');
    assert.ok(logs.info.some(m => /paused.*not connected/i.test(m)),
        `info log should mention the connectivity pause, got: ${JSON.stringify(logs.info)}`);

    // Reconnect (sender-connect's recovery paths kick drain again).
    connected = true;
    await win.SenderSend.drain();
    assert.deepEqual(sentMessages.map(m => m.type), ['batch-start'],
        'the deferred batch-start opens the batch once the transport is back');
    assert.equal(sentFiles.length, 1, 'the queued file goes out after reconnect');
    assert.equal(win.SenderSend.size(), 0);
});

test('a transient drop before file-start keeps the file queued without wedging on a resume-offer', async () => {
    const { win, fakeRtc, sentFiles } = loadIntoJsdom({ verified: true });
    // The transport raced shut between the drain gate and sendFile: the
    // entry guard throws a transient error tagged beforeFileStart. The
    // receiver never saw file-start, so no file-resume-offer will ever
    // arrive; drain must NOT enter the pausedOnTransient state (which
    // only a resume-offer clears) or the queue wedges forever.
    let calls = 0;
    fakeRtc.sendFile = async (sender, onProgress, resumeFromSeq) => {
        sentFiles.push({ sender, resumeFromSeq });
        if (++calls === 1) {
            const e = new Error('WS not open at sendFile start');
            e.transient = true;
            e.nextSeq = 0;
            e.beforeFileStart = true;
            throw e;
        }
    };

    win.SenderSend.push({ blob: makeBlob(win) });
    await win.SenderSend.drain();
    assert.equal(win.SenderSend.size(), 1, 'the file survives the failed attempt');

    // Reconnect kicks drain again; were the queue paused on transient,
    // this drain would log-and-return without sending anything.
    await win.SenderSend.drain();
    assert.equal(sentFiles.length, 2, 'the head is retried from scratch after reconnect');
    assert.equal(sentFiles[1].resumeFromSeq, undefined, 'fresh send, not a resume');
    assert.equal(win.SenderSend.size(), 0);
});

test('batch-end stays pending when its send fails and goes out on the next drain', async () => {
    const { win, fakeRtc, sentMessages } = loadIntoJsdom({ verified: true });
    // The transport drops right after the last file: batch-end's
    // sendMessage fails. The flag must survive so the marker still
    // closes the batch after the reconnect.
    let messagesGoThrough = false;
    const realSend = fakeRtc.sendMessage;
    fakeRtc.sendMessage = (m) => messagesGoThrough ? realSend(m) : false;

    win.SenderSend.markBatchEndPending();
    win.SenderSend.push({ blob: makeBlob(win) });
    await win.SenderSend.drain();
    assert.equal(sentMessages.length, 0, 'batch-end could not be delivered');

    messagesGoThrough = true;
    await win.SenderSend.drain();
    assert.deepEqual(sentMessages.map(m => m.type), ['batch-end'],
        'the kept flag must close the batch on the next drain');
});

test('updateQueuedBlob swaps the bytes of a still-queued photo and drops its half-built sender', async () => {
    const { win, sentFiles, created } = loadIntoJsdom({ verified: true });
    const first = makeBlob(win);
    const cropped = new win.Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' });
    win.SenderSend.push({ blob: first, photoId: 7 });

    // A crop lands before the send started: the queued bytes are swapped.
    assert.equal(win.SenderSend.updateQueuedBlob(7, cropped), true, 'reports the update happened');
    assert.equal(win.SenderSend.updateQueuedBlob(999, cropped), false, 'unknown photoId is a no-op');

    await win.SenderSend.drain();
    assert.equal(sentFiles.length, 1, 'the photo is sent once');
    assert.equal(created.length, 1, 'exactly one SegmentSender built (from the cropped bytes)');
    assert.equal(created[0].blob, cropped, 'the cropped blob is what reaches SegmentStream, not the original');
    assert.equal(created[0].metadata.mimeType, 'image/jpeg');
});

test('updateQueuedBlob is a no-op once the photo has left the queue', async () => {
    const { win } = loadIntoJsdom({ verified: true });
    win.SenderSend.push({ blob: makeBlob(win), photoId: 3 });
    await win.SenderSend.drain();
    assert.equal(win.SenderSend.size(), 0);
    assert.equal(win.SenderSend.updateQueuedBlob(3, makeBlob(win)), false,
        'nothing to update after the item was sent');
});
