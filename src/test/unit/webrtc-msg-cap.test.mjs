/**
 * Unit test for the wire-level control-message size cap in webrtc.js.
 * A hostile peer that sends a multi-MB JSON string would, without this
 * cap, force the receiver tab into a large allocation in JSON.parse
 * BEFORE Protocol.validate ever runs. Verify that handleMessage now
 * refuses oversized strings outright and never invokes onMessage.
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
    const logs = { info: [], warn: [], error: [], debug: [], success: [] };
    win.logger = {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
        debug: (m) => logs.debug.push(m),
        success: (m) => logs.success.push(m),
    };
    // Protocol and PayloadAssembler must be on window before webrtc.js executes.
    new win.Function(protocolSrc).call(win);
    new win.Function(assemblerSrc).call(win);
    new win.Function(webrtcSrc).call(win);
    return { win, logs };
}

test('handleMessage drops control messages exceeding MAX_CONTROL_MSG_BYTES', () => {
    const { win, logs } = setup();
    const rtc = new win.WebSendRTC();
    let onMessageCalls = 0;
    rtc.onMessage = () => { onMessageCalls++; };

    const cap = win.Protocol.MAX_CONTROL_MSG_BYTES;
    // 2x string-length factor in webrtc.js (UTF-16 byte approximation),
    // so we just need length * 2 > cap. Build a JSON-looking string
    // that, if parsed, would be a valid public-key message.
    const padding = 'A'.repeat(cap); // chars; *2 bytes definitely > cap
    const huge = JSON.stringify({ type: 'public-key', key: padding });

    rtc.handleMessage(huge);
    assert.equal(onMessageCalls, 0, 'onMessage must NOT be invoked for oversized strings');
    assert.ok(
        logs.error.some(m => /oversized control message/i.test(m)),
        `error log should mention the drop, got: ${JSON.stringify(logs.error)}`
    );
});

test('handleMessage accepts a normal control message under the cap', () => {
    const { win } = setup();
    const rtc = new win.WebSendRTC();
    let captured = null;
    rtc.onMessage = (m) => { captured = m; };

    const small = JSON.stringify({ type: 'fingerprint-confirmed' });
    rtc.handleMessage(small);
    assert.ok(captured && captured.type === 'fingerprint-confirmed',
        `onMessage should receive the parsed message, got: ${JSON.stringify(captured)}`);
});
