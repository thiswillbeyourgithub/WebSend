/**
 * Resume helpers in transport-assembler.js: state preservation across
 * a transient transport drop, getResumeState, discardInflightOnResumeReset.
 * The receive state is kept across transport teardown so a relay
 * reconnect can byte-level-resume an in-flight file.
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
// Blob is passed in for the file-end assembly path (node's global Blob).
const ctx = createContext({ window: win, logger, console, Blob });
runInContext(readFileSync(protocolPath, 'utf8'), ctx);
runInContext(readFileSync(assemblerPath, 'utf8'), ctx);

const PA = win.PayloadAssembler;
const MIN = win.Protocol.MIN_FILE_START_SIZE;

function makeHost() {
    const host = { tag: 'TEST', onMessage: () => {} };
    PA.initState(host);
    return host;
}

test('initState seeds receive fields to empty/zero', () => {
    const h = makeHost();
    assert.equal(h.receiveBuffer.length, 0);
    assert.equal(h.receivedSize, 0);
    assert.equal(h.expectedSize, 0);
    assert.equal(h._sessionTotalBytes, 0);
});

test('hasInflightTransfer returns false on fresh host', () => {
    const h = makeHost();
    assert.equal(PA.hasInflightTransfer(h), false);
});

test('hasInflightTransfer returns true after partial file-start + chunks', () => {
    const h = makeHost();
    PA.handleControl(h, { type: 'file-start', size: MIN * 4 });
    PA.handleBinary(h, new ArrayBuffer(MIN));
    assert.equal(PA.hasInflightTransfer(h), true);
});

test('hasInflightTransfer returns false once fully received', () => {
    const h = makeHost();
    PA.handleControl(h, { type: 'file-start', size: MIN });
    PA.handleBinary(h, new ArrayBuffer(MIN));
    assert.equal(PA.hasInflightTransfer(h), false);
});

test('getResumeState returns null on fresh host', () => {
    const h = makeHost();
    assert.equal(PA.getResumeState(h), null);
});

test('getResumeState returns {size, received} during a partial transfer', () => {
    const h = makeHost();
    PA.handleControl(h, { type: 'file-start', size: MIN * 4 });
    PA.handleBinary(h, new ArrayBuffer(MIN));
    PA.handleBinary(h, new ArrayBuffer(MIN));
    const s = PA.getResumeState(h);
    assert.equal(s.size, MIN * 4);
    assert.equal(s.received, MIN * 2);
});

test('partial state survives if resetReceive is NOT called', () => {
    const h = makeHost();
    PA.handleControl(h, { type: 'file-start', size: MIN * 4 });
    PA.handleBinary(h, new ArrayBuffer(MIN));
    assert.equal(h.expectedSize, MIN * 4);
    assert.equal(h.receivedSize, MIN);
    assert.equal(h.receiveBuffer.length, 1);
    const s = PA.getResumeState(h);
    assert.equal(s.size, MIN * 4);
    assert.equal(s.received, MIN);
});

test('discardInflightOnResumeReset clears the partial buffer but not session bytes', () => {
    const h = makeHost();
    PA.handleControl(h, { type: 'file-start', size: MIN * 4 });
    PA.handleBinary(h, new ArrayBuffer(MIN));
    h._sessionTotalBytes = 99999;
    PA.discardInflightOnResumeReset(h);
    assert.equal(h.receiveBuffer.length, 0);
    assert.equal(h.receivedSize, 0);
    assert.equal(h.expectedSize, 0);
    assert.equal(h._sessionTotalBytes, 99999);
});

test('resetReceive (full teardown) clears session counter too', () => {
    const h = makeHost();
    PA.handleControl(h, { type: 'file-start', size: MIN * 4 });
    PA.handleBinary(h, new ArrayBuffer(MIN));
    PA.resetReceive(h);
    assert.equal(h._sessionTotalBytes, 0);
    assert.equal(h.expectedSize, 0);
});

test('fresh file-start clears the existing buffer (invalidating any in-flight)', () => {
    const h = makeHost();
    PA.handleControl(h, { type: 'file-start', size: MIN * 4 });
    PA.handleBinary(h, new ArrayBuffer(MIN));
    PA.handleControl(h, { type: 'file-start', size: MIN * 2 });
    assert.equal(h.receiveBuffer.length, 0);
    assert.equal(h.receivedSize, 0);
    assert.equal(h.expectedSize, MIN * 2);
});

test('file-end with missing bytes emits file-incomplete, not encrypted-file', () => {
    const h = makeHost();
    const events = [];
    h.onMessage = (m) => events.push(m);
    PA.handleControl(h, { type: 'file-start', size: MIN * 4 });
    PA.handleBinary(h, new ArrayBuffer(MIN)); // only a quarter arrives
    PA.handleControl(h, { type: 'file-end' });
    const incomplete = events.find(m => m.type === 'file-incomplete');
    assert.ok(incomplete, 'expected a file-incomplete event');
    assert.equal(incomplete.received, MIN);
    assert.equal(incomplete.expected, MIN * 4);
    assert.equal(events.find(m => m.type === 'encrypted-file'), undefined,
        'a short blob must never reach the decrypt path');
    // State is cleared so the next file-start opens cleanly.
    assert.equal(h.receivedSize, 0);
    assert.equal(h.expectedSize, 0);
    assert.equal(h.receiveBuffer.length, 0);
});

test('complete file-end emits encrypted-file and leaves no inflight state', () => {
    const h = makeHost();
    const events = [];
    h.onMessage = (m) => events.push(m);
    PA.handleControl(h, { type: 'file-start', size: MIN });
    PA.handleBinary(h, new ArrayBuffer(MIN));
    PA.handleControl(h, { type: 'file-end' });
    assert.ok(events.find(m => m.type === 'encrypted-file'));
    assert.equal(events.find(m => m.type === 'file-incomplete'), undefined);
    // expectedSize must be cleared at file-end: leaving it set made
    // hasInflightTransfer() true again (receivedSize is back to 0), so a
    // reconnect after a *completed* transfer sent a bogus resume offer.
    assert.equal(PA.hasInflightTransfer(h), false);
    assert.equal(PA.getResumeState(h), null);
});

test('PayloadAssembler is frozen', () => {
    assert.equal(Object.isFrozen(PA), true);
});

test('PayloadAssembler exposes the new resume helpers', () => {
    assert.equal(typeof PA.hasInflightTransfer, 'function');
    assert.equal(typeof PA.getResumeState, 'function');
    assert.equal(typeof PA.discardInflightOnResumeReset, 'function');
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
    // and a v1 file-start afterwards leaves v2 mode
    assert.equal(PA.handleControl(host, { type: 'file-start', size: MIN }), true);
    assert.equal(host._v2Mode, false);
});

test('v2 file-end is forwarded upward, v1 file-end stays consumed', () => {
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
