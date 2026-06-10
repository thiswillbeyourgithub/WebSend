/**
 * Unit test for byte-resume in webrtc.js sendFile.
 *
 * SenderSend passes resumeFromOffset after the receiver answered our
 * file-resume-offer with a nonzero offset. The data channel path must
 * then NOT send a fresh file-start (the receiver keeps its partial
 * buffer; a file-start would reset it) and must transmit exactly the
 * bytes from that offset onward. webrtc.js used to silently ignore the
 * argument and resend the whole file.
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
const webrtcSrc = readFileSync(path.resolve(__dirname, '../../public/js/webrtc.js'), 'utf8');

function setup() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only', url: 'http://localhost/',
    });
    const win = dom.window;
    win.logger = {
        info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, success: () => {},
    };
    // Protocol and PayloadAssembler must be on window before webrtc.js executes.
    new win.Function(protocolSrc).call(win);
    new win.Function(assemblerSrc).call(win);
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

function patternedBuffer(size) {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = i % 251;
    return buf;
}

const TOTAL = 40_000;          // 3 chunks at the 16 KiB CHUNK_SIZE
const RESUME_OFFSET = 20_000;  // mid-second-chunk

async function runSendFile(win, rtc, data, resumeFromOffset) {
    const p = rtc.sendFile(data.buffer, null, resumeFromOffset);
    // The chunk loop runs synchronously (bufferedAmount stays 0) and then
    // parks on the file-ack promise; release it like a receiver ack would.
    win.PayloadAssembler.resolveFileAck(rtc, { acknowledged: true, sha256: 'x'.repeat(64) });
    return p;
}

test('sendFile without resume sends file-start and all bytes', async () => {
    const win = setup();
    const { rtc, sent } = makeRtcWithFakeChannel(win);
    const data = patternedBuffer(TOTAL);

    await runSendFile(win, rtc, data);

    assert.deepEqual(sent.control.map(m => m.type), ['file-start', 'file-end']);
    assert.equal(sent.control[0].size, TOTAL);
    const got = Buffer.concat(sent.chunks.map(c => Buffer.from(c)));
    assert.deepEqual(got, Buffer.from(data));
});

test('sendFile with resumeFromOffset skips file-start and sends only the tail', async () => {
    const win = setup();
    const { rtc, sent } = makeRtcWithFakeChannel(win);
    const data = patternedBuffer(TOTAL);

    await runSendFile(win, rtc, data, RESUME_OFFSET);

    assert.deepEqual(sent.control.map(m => m.type), ['file-end'],
        'a resume must not send file-start (it would reset the receiver buffer)');
    const got = Buffer.concat(sent.chunks.map(c => Buffer.from(c)));
    assert.deepEqual(got, Buffer.from(data.subarray(RESUME_OFFSET)),
        'exactly the bytes from the resume offset onward must be sent');
});

test('sendFile treats resumeFromOffset 0 as a fresh send', async () => {
    const win = setup();
    const { rtc, sent } = makeRtcWithFakeChannel(win);
    const data = patternedBuffer(TOTAL);

    await runSendFile(win, rtc, data, 0);

    assert.deepEqual(sent.control.map(m => m.type), ['file-start', 'file-end']);
    const got = Buffer.concat(sent.chunks.map(c => Buffer.from(c)));
    assert.equal(got.length, TOTAL);
});
