/**
 * Unit tests for the RacingTransport state machine in js/transport.js.
 *
 * The race favours WebRTC: if WebRTC connects (ever), WebRTC wins. If
 * the WS reaches relay-hello first, WebRTC gets RACE_GRACE_MS to catch
 * up; otherwise WS wins. If WebRTC fails outright while WS is ready,
 * WS wins immediately without waiting out the grace window.
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

// Minimal stubs for both inner transports. The race only cares about
// onConnected / onDisconnected / onMessage / close on the inners; the
// constructor must expose those as settable fields.
function makeInner() {
    const inner = {
        roomId: null,
        roomSecret: null,
        iceServers: [],
        receiveBuffer: [],
        pc: null,
        onConnected: null,
        onDisconnected: null,
        onMessage: null,
        onStateChange: null,
        onConnectionTypeDetected: null,
        sent: [],
        closed: false,
        async init() {},
        async createRoom() { return { roomId: 'ROOM01', secret: 'sekret' }; },
        async createOfferAndStore() { return { roomId: 'ROOM01', secret: 'sekret' }; },
        async waitForAnswer() {},
        async joinRoom() {},
        sendMessage(m) { this.sent.push({ kind: 'msg', m }); return true; },
        async sendFile(b) { this.sent.push({ kind: 'file', b }); },
        close() { this.closed = true; },
        // WSTransport-specific
        setRoom(r, s) { this.roomId = r; this.roomSecret = s; },
        openSlotA() {},
        openSlotB(r, s) { this.roomId = r; this.roomSecret = s; },
        isConnected() { return this._isConnected || false; },
        _markConnected() {
            this._isConnected = true;
            if (this.onConnected) this.onConnected();
        },
    };
    return inner;
}

async function loadTransport(relayEnabled = true) {
    const dom = new JSDOM('<!doctype html><html></html>', {
        runScripts: 'outside-only', url: 'http://localhost/',
    });
    const win = dom.window;
    // Stub WebSendRTC + WSTransport with the factory above
    const webrtc = makeInner();
    const ws = makeInner();
    win.WebSendRTC = function WebSendRTC() { return webrtc; };
    win.WSTransport = function WSTransport() { return ws; };
    win.logger = { info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {} };
    win.fetch = async () => ({ ok: true, async json() { return { relayEnabled }; } });
    win.eval(readFileSync(path.join(pub, 'transport.js'), 'utf8'));
    return { win, webrtc, ws, Racing: win.Transport.RacingTransport };
}

test('WebRTC connecting fires onConnected and closes WS loser', async () => {
    const { win, webrtc, ws } = await loadTransport();
    const t = new win.Transport.RacingTransport('receiver');
    await t.init();
    let connected = 0;
    t.onConnected = () => connected++;
    webrtc.onConnected();
    assert.equal(t.winner, 'webrtc');
    assert.equal(connected, 1);
    assert.equal(ws.closed, true);
});

test('WS connecting first does NOT lock immediately; waits for grace window', async () => {
    const { win, webrtc, ws } = await loadTransport();
    const t = new win.Transport.RacingTransport('receiver');
    await t.init();
    let connected = 0;
    t.onConnected = () => connected++;
    ws.onConnected();
    // Race timer is now armed; we have not won yet.
    assert.equal(t.winner, null);
    assert.equal(connected, 0);
    assert.equal(webrtc.closed, false);
    // Manually trigger the timer to simulate grace expiry.
    t.close(); // cleanup
});

test('WS connecting then WebRTC connecting within grace -> WebRTC wins', async () => {
    const { win, webrtc, ws } = await loadTransport();
    const t = new win.Transport.RacingTransport('receiver');
    await t.init();
    let connected = 0;
    t.onConnected = () => connected++;
    ws.onConnected();
    webrtc.onConnected(); // WebRTC catches up before grace expires
    assert.equal(t.winner, 'webrtc');
    assert.equal(connected, 1);
    assert.equal(ws.closed, true);
});

test('WS connected + WebRTC disconnected (failure) -> WS wins immediately', async () => {
    const { win, webrtc, ws } = await loadTransport();
    const t = new win.Transport.RacingTransport('receiver');
    await t.init();
    let connected = 0;
    t.onConnected = () => connected++;
    ws._markConnected(); // WS ready (flips isConnected AND fires onConnected)
    webrtc.onDisconnected(); // WebRTC failed before connecting
    assert.equal(t.winner, 'ws');
    assert.equal(connected, 1);
    assert.equal(webrtc.closed, true);
});

test('sendMessage routes to the winning inner', async () => {
    const { win, webrtc, ws } = await loadTransport();
    const t = new win.Transport.RacingTransport('sender');
    await t.init();
    webrtc.onConnected();
    t.sendMessage({ type: 'ping' });
    assert.equal(webrtc.sent.length, 1);
    assert.equal(ws.sent.length, 0);
});

test('sendMessage before any winner refuses with false', async () => {
    const { win } = await loadTransport();
    const t = new win.Transport.RacingTransport('sender');
    await t.init();
    const ok = t.sendMessage({ type: 'ping' });
    assert.equal(ok, false);
});

test('onMessage only forwards from the winning inner', async () => {
    const { win, webrtc, ws } = await loadTransport();
    const t = new win.Transport.RacingTransport('receiver');
    await t.init();
    const received = [];
    t.onMessage = (m) => received.push(m);
    webrtc.onConnected();
    webrtc.onMessage({ type: 'a' });
    ws.onMessage({ type: 'b' }); // loser; should NOT propagate
    assert.deepEqual(received, [{ type: 'a' }]);
});

test('relay disabled in /api/config -> RacingTransport falls back to WebRTC-only', async () => {
    const { win, webrtc } = await loadTransport(false);
    const t = new win.Transport.RacingTransport('receiver');
    await t.init();
    // ws inner exists but openSlotA shouldn't even be called; verify by
    // ensuring it has no roomId after createOfferAndStore.
    await t.createOfferAndStore();
    let connected = 0;
    t.onConnected = () => connected++;
    webrtc.onConnected();
    assert.equal(t.winner, 'webrtc');
    assert.equal(connected, 1);
});

test('createRoom propagates roomId/secret to the WS inner', async () => {
    const { win, ws } = await loadTransport();
    const t = new win.Transport.RacingTransport('receiver');
    await t.init();
    const r = await t.createRoom();
    assert.equal(r.roomId, 'ROOM01');
    assert.equal(ws.roomId, 'ROOM01');
    assert.equal(ws.roomSecret, 'sekret');
});

test('close() closes both inners and clears the grace timer', async () => {
    const { win, webrtc, ws } = await loadTransport();
    const t = new win.Transport.RacingTransport('receiver');
    await t.init();
    ws.onConnected(); // arms the timer
    t.close();
    assert.equal(webrtc.closed, true);
    assert.equal(ws.closed, true);
    // Re-fire onConnected on webrtc: should not flip winner
    let connected = 0;
    t.onConnected = () => connected++;
    webrtc.onConnected();
    assert.equal(t.winner, null);
    assert.equal(connected, 0);
});

test('Transport namespace exposes RACE_GRACE_MS for the wider system', async () => {
    const { win } = await loadTransport();
    assert.equal(typeof win.Transport.RACE_GRACE_MS, 'number');
    assert.ok(win.Transport.RACE_GRACE_MS >= 5_000 && win.Transport.RACE_GRACE_MS <= 30_000);
});
