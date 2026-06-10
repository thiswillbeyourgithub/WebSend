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
