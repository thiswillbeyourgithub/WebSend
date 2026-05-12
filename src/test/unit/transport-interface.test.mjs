/**
 * Verifies the Transport abstraction (js/transport.js) exposes the
 * expected factory surface, returns instances that satisfy the duck-
 * typed Transport interface that the receiver and sender flows rely on,
 * and is frozen so a hostile script cannot swap a factory to hand back
 * a tampered transport (e.g. one whose sendMessage drops fingerprint-
 * confirmed or whose isVerified always returns true).
 *
 * Generated with the help of Claude Code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(__dirname, '../../public/js');

// Stub WebSendRTC because the real class needs RTCPeerConnection / fetch.
// We only assert that Transport returns whatever WebSendRTC instance the
// factory produces.
const STUB_RTC = `
    class WebSendRTC {
        constructor() {
            this.iceServers = [];
            this.onConnected = null;
            this.onDisconnected = null;
            this.onMessage = null;
            this.onStateChange = null;
            this.onConnectionTypeDetected = null;
            this.receiveBuffer = [];
            this.pc = null;
            this._isStub = true;
        }
        async init() {}
        async createOfferAndStore() { return { roomId: 'ROOM01', secret: 'secret' }; }
        async waitForAnswer() {}
        async joinRoom() {}
        sendMessage() { return true; }
        async sendFile() {}
        close() {}
    }
    window.WebSendRTC = WebSendRTC;
`;

function loadTransportWindow() {
    const dom = new JSDOM('<!doctype html><html></html>', { runScripts: 'outside-only' });
    dom.window.eval(STUB_RTC);
    dom.window.eval(readFileSync(path.join(pub, 'transport.js'), 'utf8'));
    return dom.window;
}

test('window.Transport is exposed with the documented factory methods', () => {
    const win = loadTransportWindow();
    assert.equal(typeof win.Transport, 'object');
    assert.equal(typeof win.Transport.createForReceiver, 'function');
    assert.equal(typeof win.Transport.createForSender, 'function');
});

test('window.Transport is frozen so factories cannot be tampered with', () => {
    const win = loadTransportWindow();
    assert.ok(Object.isFrozen(win.Transport));
    const original = win.Transport.createForSender;
    try { win.Transport.createForSender = () => ({ evil: true }); } catch (_) {}
    assert.equal(win.Transport.createForSender, original);
});

test('createForReceiver returns an object that satisfies the Transport interface', () => {
    const win = loadTransportWindow();
    const t = win.Transport.createForReceiver();
    // Lifecycle
    assert.equal(typeof t.init, 'function');
    assert.equal(typeof t.createOfferAndStore, 'function');
    assert.equal(typeof t.waitForAnswer, 'function');
    assert.equal(typeof t.joinRoom, 'function');
    assert.equal(typeof t.close, 'function');
    // Data plane
    assert.equal(typeof t.sendMessage, 'function');
    assert.equal(typeof t.sendFile, 'function');
    // Event callback fields exist (assignable null sentinels) so the
    // wiring loop in sender-connect / receive.html doesn't blow up.
    assert.equal(t.onConnected, null);
    assert.equal(t.onDisconnected, null);
    assert.equal(t.onMessage, null);
    assert.equal(t.onStateChange, null);
    assert.equal(t.onConnectionTypeDetected, null);
    // State surface
    assert.ok(Array.isArray(t.iceServers));
    assert.ok(Array.isArray(t.receiveBuffer));
});

test('createForSender returns an object that satisfies the Transport interface', () => {
    const win = loadTransportWindow();
    const t = win.Transport.createForSender();
    assert.equal(typeof t.init, 'function');
    assert.equal(typeof t.joinRoom, 'function');
    assert.equal(typeof t.sendMessage, 'function');
    assert.equal(typeof t.sendFile, 'function');
    assert.equal(typeof t.close, 'function');
});

test('factories return fresh instances each call (no shared state)', () => {
    const win = loadTransportWindow();
    const a = win.Transport.createForReceiver();
    const b = win.Transport.createForReceiver();
    assert.notEqual(a, b);
});
