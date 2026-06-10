/**
 * Unit test for the visibility-aware disconnect grace in webrtc.js.
 *
 * WebRTC reports "disconnected" not only on a transient ICE blip but
 * ALSO whenever the page is backgrounded (e.g. the user opens the native
 * file/photo picker or switches apps), because the browser suspends the
 * connection. The old code armed a fixed 5s grace and then tore the
 * session down, which fired while the user was still in the picker and
 * left them with a dead pairing + a fresh verification ceremony on
 * return ("too eager to disconnect").
 *
 * _scheduleDisconnectGrace now defers the terminal decision while the
 * page is hidden, arming a one-shot visibilitychange listener instead,
 * and only starts the short recovery grace once the page is visible
 * again. These tests pin that state machine.
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

function setVisibility(win, value) {
    Object.defineProperty(win.document, 'visibilityState', { value, configurable: true });
}

function setup(visibility = 'visible') {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only', url: 'http://localhost/',
    });
    const win = dom.window;
    setVisibility(win, visibility);
    win.logger = {
        info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, success: () => {},
    };
    new win.Function(protocolSrc).call(win);
    new win.Function(assemblerSrc).call(win);
    new win.Function(webrtcSrc).call(win);
    return { win };
}

function makeRtc(win, connectionState) {
    const rtc = new win.WebSendRTC();
    // Minimal fake peer connection: the grace logic only reads
    // connectionState; close() is exercised by the close() test.
    rtc.pc = { connectionState, close() {} };
    return rtc;
}

test('hidden page: defers teardown (no grace timer, arms visibility listener)', () => {
    const { win } = setup('hidden');
    const rtc = makeRtc(win, 'disconnected');
    let disc = 0;
    rtc.onDisconnected = () => { disc++; };

    rtc._scheduleDisconnectGrace();

    assert.ok(!rtc._disconnectTimer, 'must NOT arm the 5s grace timer while hidden');
    assert.equal(typeof rtc._visibilityResumeHandler, 'function', 'must arm a visibility resume listener');
    assert.equal(disc, 0, 'onDisconnected must not fire while hidden');
    rtc.close();
});

test('visible page: starts the 5s grace immediately', () => {
    const { win } = setup('visible');
    const rtc = makeRtc(win, 'disconnected');

    rtc._scheduleDisconnectGrace();

    assert.ok(rtc._disconnectTimer, 'must arm the grace timer while visible');
    assert.ok(!rtc._visibilityResumeHandler, 'must not arm a visibility resume listener while visible');
    rtc.close(); // clears the grace timer via the jsdom timer context
});

test('returning to foreground while still disconnected starts the grace', () => {
    const { win } = setup('hidden');
    const rtc = makeRtc(win, 'disconnected');
    rtc._scheduleDisconnectGrace();
    assert.equal(typeof rtc._visibilityResumeHandler, 'function');

    setVisibility(win, 'visible');
    win.document.dispatchEvent(new win.Event('visibilitychange'));

    assert.ok(rtc._disconnectTimer, 'grace timer must start once back in the foreground');
    assert.ok(!rtc._visibilityResumeHandler, 'resume listener must be cleared after firing');
    rtc.close(); // clears the grace timer via the jsdom timer context
});

test('returning to foreground after ICE self-heals is a no-op', () => {
    const { win } = setup('hidden');
    const rtc = makeRtc(win, 'disconnected');
    let disc = 0;
    rtc.onDisconnected = () => { disc++; };
    rtc._scheduleDisconnectGrace();

    // ICE recovered while we were backgrounded.
    rtc.pc.connectionState = 'connected';
    setVisibility(win, 'visible');
    win.document.dispatchEvent(new win.Event('visibilitychange'));

    assert.ok(!rtc._disconnectTimer, 'no grace timer when the connection already recovered');
    assert.ok(!rtc._visibilityResumeHandler, 'resume listener cleared');
    assert.equal(disc, 0, 'onDisconnected must not fire on a recovered connection');
});

test('close() clears an armed visibility resume listener', () => {
    const { win } = setup('hidden');
    const rtc = makeRtc(win, 'disconnected');
    rtc._scheduleDisconnectGrace();
    assert.equal(typeof rtc._visibilityResumeHandler, 'function');

    rtc.close();
    assert.ok(!rtc._visibilityResumeHandler, 'close() must remove the resume listener');

    // A late visibilitychange after close() must not re-arm a grace timer.
    setVisibility(win, 'visible');
    win.document.dispatchEvent(new win.Event('visibilitychange'));
    assert.ok(!rtc._disconnectTimer, 'no grace timer should be armed after close()');
});
