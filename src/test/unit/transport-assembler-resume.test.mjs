/**
 * v2 record parser in transport-assembler.js: crypto-free framing of
 * [4B BE seq][4B BE ctLen][ct] records, parser lifecycle across resets
 * and reconnects (resetParser / armV2Parser), and abuse bounds.
 * Resume state itself lives in ReceiveFlow's SegmentReceiver; the
 * assembler only re-arms its parser from the file-resume-ack.
 *
 * Generated with the help of Claude Code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const protocolPath = path.resolve(__dirname, '../../public/js/protocol.js');
const assemblerPath = path.resolve(__dirname, '../../public/js/transport-assembler.js');

// Load both scripts into a single vm context so PayloadAssembler can see
// the same window object as Protocol.
const win = {};
const logger = { info: () => {}, success: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
// Blob is passed in for the file-end assembly path (node's global Blob);
// timers back the file-ack timeout in setupFileAck.
const ctx = createContext({ window: win, logger, console, Blob, setTimeout, clearTimeout });
runInContext(readFileSync(protocolPath, 'utf8'), ctx);
runInContext(readFileSync(assemblerPath, 'utf8'), ctx);

const PA = win.PayloadAssembler;

test('initState seeds a disarmed parser and zeroed session counter', () => {
    const h = { tag: 'TEST', onMessage: () => {} };
    PA.initState(h);
    assert.equal(h._v2Mode, false);
    assert.equal(h._v2Pending, null);
    assert.equal(h._sessionTotalBytes, 0);
});

test('resetReceive clears the session counter and disarms the parser', () => {
    const h = { tag: 'TEST', onMessage: () => {} };
    PA.initState(h);
    h._sessionTotalBytes = 99999;
    h._v2Mode = true;
    PA.resetReceive(h);
    assert.equal(h._sessionTotalBytes, 0);
    assert.equal(h._v2Mode, false);
});

test('PayloadAssembler is frozen', () => {
    assert.equal(Object.isFrozen(PA), true);
});

test('PayloadAssembler exposes the parser lifecycle helpers', () => {
    assert.equal(typeof PA.resetParser, 'function');
    assert.equal(typeof PA.armV2Parser, 'function');
});

// ---- v2 record parser (chunked AEAD transfers) ----

const SEG = win.Protocol.SEG_SIZE;
const SALT_B64 = 'A'.repeat(22) + '==';

function v2Start(h, segCount = 3) {
    return PA.handleControl(h, {
        type: 'file-start', v: 2, segSize: SEG, segCount, salt: SALT_B64,
    });
}

/** Build a wire record [4B BE seq][4B BE ctLen][ct of ctLen 0xAB bytes]. */
function wireRecord(seq, ctLen = 32) {
    const rec = new Uint8Array(8 + ctLen);
    const view = new DataView(rec.buffer);
    view.setUint32(0, seq, false);
    view.setUint32(4, ctLen, false);
    rec.fill(0xab, 8);
    return rec;
}

function makeV2Host() {
    const events = [];
    const aborts = [];
    const host = {
        tag: 'TEST',
        onMessage: (m) => events.push(m),
        _abortTransport: (reason) => aborts.push(reason),
    };
    PA.initState(host);
    return { host, events, aborts };
}

test('v2 file-start is forwarded upward (gating) and enters parser mode', () => {
    const { host } = makeV2Host();
    assert.equal(v2Start(host), false,
        'v2 file-start must reach onMessage so the verification gate sees it');
    assert.equal(host._v2Mode, true);
});

test('non-v2 file-start is forwarded with the parser disarmed (unsupported-version path)', () => {
    const { host, aborts } = makeV2Host();
    assert.equal(PA.handleControl(host, { type: 'file-start', size: 262144 }), false,
        'legacy file-start must reach the receive flow so it can nack unsupported-version');
    assert.equal(host._v2Mode, false);
    // Any binary that follows has no parser to feed and is abusive.
    PA.handleBinary(host, new ArrayBuffer(64));
    assert.equal(aborts.length, 1);
    assert.match(aborts[0], /before file-start/);
});

test('file-end is forwarded upward', () => {
    const { host } = makeV2Host();
    v2Start(host);
    assert.equal(PA.handleControl(host, { type: 'file-end' }), false);
});

test('one chunk carrying several records emits them all in order', () => {
    const { host, events } = makeV2Host();
    v2Start(host);
    const combined = new Uint8Array(2 * (8 + 32));
    combined.set(wireRecord(0), 0);
    combined.set(wireRecord(1), 8 + 32);
    PA.handleBinary(host, combined.buffer);
    const segs = events.filter(e => e.type === 'file-segment');
    assert.deepEqual(segs.map(s => s.seq), [0, 1]);
    assert.equal(segs[0].ct.byteLength, 32);
});

test('a record spanning several chunks is reassembled exactly once', () => {
    const { host, events } = makeV2Host();
    v2Start(host);
    const rec = wireRecord(0, 100);
    PA.handleBinary(host, rec.slice(0, 5).buffer);   // header split mid-way
    PA.handleBinary(host, rec.slice(5, 60).buffer);
    assert.equal(events.filter(e => e.type === 'file-segment').length, 0,
        'no segment before the record completes');
    PA.handleBinary(host, rec.slice(60).buffer);
    const segs = events.filter(e => e.type === 'file-segment');
    assert.equal(segs.length, 1);
    assert.equal(segs[0].seq, 0);
    assert.equal(segs[0].ct.byteLength, 100);
    assert.deepEqual(new Uint8Array(segs[0].ct), new Uint8Array(100).fill(0xab));
});

test('progress events carry exact record counts (seq/segCount)', () => {
    const { host, events } = makeV2Host();
    v2Start(host, 3);
    PA.handleBinary(host, wireRecord(0).buffer);
    const prog = events.filter(e => e.type === 'progress').pop();
    assert.equal(prog.seq, 0);
    assert.equal(prog.segCount, 3);
    assert.ok(prog.total >= prog.received);
});

test('a record seq skipping forward aborts the transport (framing desync)', () => {
    const { host, events, aborts } = makeV2Host();
    v2Start(host);
    PA.handleBinary(host, wireRecord(0).buffer);
    PA.handleBinary(host, wireRecord(2).buffer); // skipped 1
    assert.equal(aborts.length, 1);
    assert.match(aborts[0], /skipped ahead/);
    assert.equal(events.filter(e => e.type === 'file-segment').length, 1);
});

test('a record seq going backward is tolerated (sender rewind)', () => {
    const { host, events, aborts } = makeV2Host();
    v2Start(host);
    PA.handleBinary(host, wireRecord(0).buffer);
    PA.handleBinary(host, wireRecord(1).buffer);
    PA.handleBinary(host, wireRecord(1).buffer); // rewound resend
    assert.equal(aborts.length, 0);
    const segs = events.filter(e => e.type === 'file-segment');
    assert.deepEqual(segs.map(s => s.seq), [0, 1, 1]);
});

test('an out-of-bounds record length aborts before buffering anything', () => {
    const { host, aborts } = makeV2Host();
    v2Start(host);
    const evil = wireRecord(0, 64);
    new DataView(evil.buffer).setUint32(4, SEG * 1024, false); // claims 256 MiB
    PA.handleBinary(host, evil.buffer);
    assert.equal(aborts.length, 1);
    assert.match(aborts[0], /out of bounds/);
});

test('the pending partial buffer stays bounded by one record', () => {
    const { host } = makeV2Host();
    v2Start(host);
    const rec = wireRecord(0, SEG); // near-max legal record
    PA.handleBinary(host, rec.slice(0, rec.length - 1).buffer);
    assert.ok(host._v2Pending.length <= 8 + SEG + 21,
        'pending must never exceed one max-size record');
});

test('resetParser drops a half-buffered record and re-arms the expected seq', () => {
    const { host, events } = makeV2Host();
    v2Start(host);
    PA.handleBinary(host, wireRecord(0).buffer);
    PA.handleBinary(host, wireRecord(1, 100).slice(0, 50).buffer); // partial
    PA.resetParser(host, 1);
    // The resumed stream restarts cleanly at record 1.
    PA.handleBinary(host, wireRecord(1).buffer);
    const segs = events.filter(e => e.type === 'file-segment');
    assert.deepEqual(segs.map(s => s.seq), [0, 1],
        'the half-buffered bytes must not corrupt the resumed stream');
});

test('v2 session byte cap still aborts the stream', () => {
    const { host, aborts } = makeV2Host();
    v2Start(host);
    host._sessionTotalBytes = win.Protocol.MAX_TOTAL_SESSION_BYTES - 10;
    PA.handleBinary(host, wireRecord(0).buffer);
    assert.equal(aborts.length, 1);
    assert.match(aborts[0], /session byte cap/);
});

test('segment-nack with an ack waiter resolves it with {segmentNack: seq}', async () => {
    const { host } = makeV2Host();
    const verdict = new Promise((resolve, reject) => {
        PA.setupFileAck(host, resolve, reject, 60_000);
    });
    assert.equal(PA.handleControl(host, { type: 'segment-nack', seq: 4 }), true,
        'segment-nack is consumed by the assembler, never forwarded');
    // Field-wise compare: the verdict object comes from the vm realm,
    // whose Object.prototype differs from this realm's.
    assert.equal((await verdict).segmentNack, 4);
    assert.equal(host._segmentNackSeq, null, 'a delivered nack leaves nothing stored');
});

test('segment-nack arriving before the ack waiter is stored and delivered once', async () => {
    const { host } = makeV2Host();
    // Nack lands while records are still being pumped (no waiter yet).
    assert.equal(PA.handleControl(host, { type: 'segment-nack', seq: 2 }), true);
    assert.equal(host._segmentNackSeq, 2);

    const verdict = await new Promise((resolve, reject) => {
        PA.setupFileAck(host, resolve, reject, 60_000);
    });
    assert.equal(verdict.segmentNack, 2);
    assert.equal(host._segmentNackSeq, null);

    // The next wait must NOT see the same nack again (that would loop
    // the retry tail forever); it waits for a real verdict.
    let settled = false;
    const second = new Promise((resolve, reject) => {
        PA.setupFileAck(host, resolve, reject, 60_000);
    }).then((v) => { settled = true; return v; });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(settled, false, 'stale nack must not re-resolve');
    PA.handleControl(host, { type: 'file-ack', sha256: 'a'.repeat(64) });
    assert.equal((await second).acknowledged, true);
});

test('armV2Parser readies a fresh host for resumed records without a file-start', () => {
    // After a reconnect the winner can be a fresh transport object whose
    // parser never saw the original v2 file-start; receive.html re-arms
    // it from the file-resume-ack. Without that, the first resumed
    // record would abort as "binary chunk before file-start".
    const { host, events, aborts } = makeV2Host();
    PA.armV2Parser(host, 3, 2);
    PA.handleBinary(host, wireRecord(2).buffer);
    assert.equal(aborts.length, 0, 'resumed records must not be treated as abusive');
    const segs = events.filter(e => e.type === 'file-segment');
    assert.deepEqual(segs.map(s => s.seq), [2]);
    const progress = events.filter(e => e.type === 'progress');
    assert.equal(progress.at(-1).segCount, 3, 'progress keeps the exact segment count');
});
