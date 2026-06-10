/**
 * Unit tests for v2 record sending over the WebRTC data channel
 * (webrtc.js sendFile driving SegmentStream.pump).
 *
 * SenderSend passes resumeFromSeq after the receiver answered our
 * file-resume-offer. The data channel path must then NOT send a fresh
 * file-start (the receiver kept its verified segments and was re-keyed
 * via file-resume-ack) and must transmit exactly the records from that
 * seq onward. A channel drop mid-transfer must surface as a
 * TransientDisconnectError tagged with the record to resume from,
 * which webrtc.js historically did not support (only WS/LP did).
 *
 * Generated with the help of Claude Code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const protocolSrc = readFileSync(path.resolve(__dirname, '../../public/js/protocol.js'), 'utf8');
const assemblerSrc = readFileSync(path.resolve(__dirname, '../../public/js/transport-assembler.js'), 'utf8');
const segmentStreamSrc = readFileSync(path.resolve(__dirname, '../../public/js/segment-stream.js'), 'utf8');
const webrtcSrc = readFileSync(path.resolve(__dirname, '../../public/js/webrtc.js'), 'utf8');

function setup() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only', url: 'http://localhost/',
    });
    const win = dom.window;
    win.logger = {
        info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, success: () => {},
    };
    // Protocol, PayloadAssembler, and SegmentStream (for pump and the
    // shared TransientDisconnectError) must be on window before
    // webrtc.js's sendFile runs.
    new win.Function(protocolSrc).call(win);
    new win.Function(assemblerSrc).call(win);
    new win.Function(segmentStreamSrc).call(win);
    new win.Function(webrtcSrc).call(win);
    return win;
}

// Fake data channel: stays drained (bufferedAmount 0) so the chunk loop
// never awaits, and records control strings / binary chunks separately.
function makeRtcWithFakeChannel(win) {
    const rtc = new win.WebSendRTC();
    const sent = { control: [], chunks: [] };
    rtc.dataChannel = {
        readyState: 'open',
        bufferedAmount: 0,
        send(data) {
            if (typeof data === 'string') sent.control.push(JSON.parse(data));
            else sent.chunks.push(new Uint8Array(data));
        },
    };
    return { rtc, sent };
}

const RECORD_SIZE = 16384; // one data-channel chunk per record
const SEG_COUNT = 3;       // records 0 (meta) through 3
const VALID_SALT = 'A'.repeat(22) + '==';

// Fake SegmentSender producing fixed-size records (byte value = seq+1)
// so the wire content is assertable without WebCrypto in this realm.
// The real sealing is covered by segment-stream.test.mjs.
function makeFakeSender() {
    let nextSeq = 0;
    return {
        segCount: SEG_COUNT,
        totalRecords: SEG_COUNT + 1,
        get nextSeq() { return nextSeq; },
        saltB64: VALID_SALT,
        estimatedWireSize: (SEG_COUNT + 1) * RECORD_SIZE,
        estimateWireOffset: (seq) => seq * RECORD_SIZE,
        async next() {
            if (nextSeq > SEG_COUNT) return null;
            const seq = nextSeq++;
            return {
                seq,
                bytes: new Uint8Array(RECORD_SIZE).fill(seq + 1).buffer,
                isFinal: seq === SEG_COUNT,
            };
        },
        async rewind(seq) { nextSeq = seq; return { saltB64: VALID_SALT }; },
        async finishHash() { return 'c'.repeat(64); },
    };
}

async function runSendFile(win, rtc, sender, resumeFromSeq) {
    const p = rtc.sendFile(sender, null, resumeFromSeq);
    // The record loop runs without awaiting timers (bufferedAmount stays
    // 0) and then parks on the file-ack promise; release it like a
    // receiver ack would. Wait a macrotask so the loop reaches the park.
    await new Promise(r => setTimeout(r, 0));
    win.PayloadAssembler.resolveFileAck(rtc, { acknowledged: true, sha256: 'c'.repeat(64) });
    return p;
}

test('sendFile without resume sends a v2 file-start and every record', async () => {
    const win = setup();
    const { rtc, sent } = makeRtcWithFakeChannel(win);

    await runSendFile(win, rtc, makeFakeSender());

    assert.deepEqual(sent.control.map(m => m.type), ['file-start', 'file-end']);
    assert.equal(sent.control[0].v, 2);
    assert.equal(sent.control[0].segCount, SEG_COUNT);
    assert.equal(sent.control[0].salt, VALID_SALT);
    assert.equal(sent.chunks.length, SEG_COUNT + 1, 'one chunk per record at this size');
    sent.chunks.forEach((chunk, i) => {
        assert.equal(chunk.length, RECORD_SIZE);
        assert.equal(chunk[0], i + 1, `record ${i} content must arrive in order`);
    });
});

test('sendFile with resumeFromSeq skips file-start and sends only the tail records', async () => {
    const win = setup();
    const { rtc, sent } = makeRtcWithFakeChannel(win);
    const sender = makeFakeSender();
    await sender.rewind(2); // SenderSend rewinds before calling the transport

    await runSendFile(win, rtc, sender, 2);

    assert.deepEqual(sent.control.map(m => m.type), ['file-end'],
        'a resume must not send file-start (the receiver kept its verified segments)');
    assert.deepEqual(sent.chunks.map(c => c[0]), [3, 4],
        'exactly records 2..segCount must be re-sent');
});

test('sendFile treats resumeFromSeq 0 as a fresh send', async () => {
    const win = setup();
    const { rtc, sent } = makeRtcWithFakeChannel(win);

    await runSendFile(win, rtc, makeFakeSender(), 0);

    assert.deepEqual(sent.control.map(m => m.type), ['file-start', 'file-end']);
    assert.equal(sent.chunks.length, SEG_COUNT + 1);
});

test('a channel close mid-transfer throws a transient error carrying the resume seq', async () => {
    const win = setup();
    const { rtc, sent } = makeRtcWithFakeChannel(win);
    // Drop the channel after record 1 has been handed to the wire.
    const realSend = rtc.dataChannel.send.bind(rtc.dataChannel);
    rtc.dataChannel.send = (data) => {
        realSend(data);
        if (sent.chunks.length === 2) rtc.dataChannel.readyState = 'closed';
    };

    await assert.rejects(
        () => rtc.sendFile(makeFakeSender(), null),
        (e) => {
            assert.equal(e.name, 'TransientDisconnectError');
            assert.equal(e.transient, true, 'webrtc drops must be resumable, not fatal');
            assert.equal(e.nextSeq, 2, 'the record in flight when the channel died must be resent');
            return true;
        });
    assert.equal(rtc._fileAckInFlight, false, 'in-flight flag must clear on the throw path');
});
