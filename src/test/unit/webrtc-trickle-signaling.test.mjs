/**
 * Unit tests for trickle-ICE signaling speed in webrtc.js.
 *
 * Historically both sides blocked on full ICE gathering (waitForICE, up to
 * 15s with a TURNS server configured) before posting their SDP, so the room
 * was not joinable for 10-30s even though the QR was already on screen.
 * With trickle ICE the offer/answer must be posted immediately after
 * setLocalDescription; candidates flow through /api/rooms/:id/ice/* instead.
 *
 * The mock RTCPeerConnection below NEVER completes ICE gathering, so any
 * regression that re-blocks SDP storage on gathering makes these tests fail
 * via the 2s race timeout.
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

class MockPeerConnection {
    constructor(config) {
        this._config = config;
        this.iceGatheringState = 'new'; // never reaches 'complete'
        this.iceConnectionState = 'new';
        this.connectionState = 'new';
        this.signalingState = 'stable';
        this.localDescription = null;
        this.remoteDescription = null;
    }
    createDataChannel(label, opts) {
        return { label, ordered: opts?.ordered, readyState: 'connecting', binaryType: null, close() {} };
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nmock-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nmock-answer' }; }
    async setLocalDescription(desc) { this.localDescription = desc; }
    async setRemoteDescription(desc) { this.remoteDescription = desc; }
    async addIceCandidate() {}
    addEventListener() {}
    removeEventListener() {}
    getConfiguration() { return this._config; }
    close() {}
}

function setup(fetchImpl) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only', url: 'http://localhost/',
    });
    const win = dom.window;
    win.logger = {
        info() {}, warn() {}, error() {}, debug() {}, success() {},
    };
    win.RTCPeerConnection = MockPeerConnection;
    win.RTCSessionDescription = class { constructor(init) { Object.assign(this, init); } };
    win.RTCIceCandidate = class { constructor(init) { Object.assign(this, init); } };
    win.fetch = fetchImpl;
    new win.Function(protocolSrc).call(win);
    new win.Function(assemblerSrc).call(win);
    new win.Function(webrtcSrc).call(win);
    return { win };
}

function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

/** Fail the test if `promise` blocks on the never-finishing ICE gather. */
async function withinTwoSeconds(promise, label) {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} blocked on ICE gathering`)), 2000);
    });
    try {
        return await Promise.race([promise, guard]);
    } finally {
        clearTimeout(timer);
    }
}

test('receiver posts the offer immediately, without waiting for ICE gathering', async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.endsWith('/offer') && opts.method === 'POST') return jsonResponse({});
        throw new Error(`unexpected fetch in test: ${url}`);
    };
    const { win } = setup(fetchImpl);
    const rtc = new win.WebSendRTC();
    rtc.roomId = 'ABC123';
    rtc.roomSecret = 'shhh';

    const result = await withinTwoSeconds(rtc.createOfferAndStore(), 'createOfferAndStore');
    assert.equal(result.roomId, 'ABC123');

    const offerPost = calls.find(c => c.url === '/api/rooms/ABC123/offer' && c.method === 'POST');
    assert.ok(offerPost, `offer must be POSTed, calls: ${JSON.stringify(calls.map(c => c.url))}`);
    assert.equal(JSON.parse(offerPost.body).type, 'offer');
    win.close();
});

test('sender posts the answer immediately and tolerates a not-yet-stored offer', async () => {
    let roomChecks = 0;
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method });
        if (url === '/api/rooms/RID42' && method === 'GET') {
            roomChecks++;
            // First check lands in the QR-rendered-but-offer-not-stored gap.
            return jsonResponse({ exists: true, hasOffer: roomChecks > 1 });
        }
        if (url === '/api/rooms/RID42/offer' && method === 'GET') {
            return jsonResponse({ type: 'offer', sdp: 'v=0\r\nmock-offer' });
        }
        if (url === '/api/rooms/RID42/ice/offer' && method === 'GET') {
            return jsonResponse({ candidates: [] });
        }
        if (url === '/api/rooms/RID42/answer' && method === 'POST') {
            return jsonResponse({});
        }
        throw new Error(`unexpected fetch in test: ${method} ${url}`);
    };
    const { win } = setup(fetchImpl);
    const rtc = new win.WebSendRTC();
    rtc._OFFER_POLL_INTERVAL_MS = 10;

    await withinTwoSeconds(rtc.joinRoom('RID42', 'shhh'), 'joinRoom');

    assert.equal(roomChecks, 2, 'join must retry the room check until hasOffer is true');
    assert.ok(
        calls.some(c => c.url === '/api/rooms/RID42/answer' && c.method === 'POST'),
        'answer must be POSTed despite ICE gathering never completing'
    );
    rtc.close();
    win.close();
});

test('sender still fails cleanly when the offer never appears', async () => {
    const fetchImpl = async (url, opts = {}) => {
        if (url === '/api/rooms/GONE' && (opts.method || 'GET') === 'GET') {
            return jsonResponse({ exists: true, hasOffer: false });
        }
        throw new Error(`unexpected fetch in test: ${url}`);
    };
    const { win } = setup(fetchImpl);
    const rtc = new win.WebSendRTC();
    rtc._OFFER_WAIT_MS = 50;
    rtc._OFFER_POLL_INTERVAL_MS = 10;

    await assert.rejects(
        () => rtc.joinRoom('GONE', 'shhh'),
        /has not finished setting up/,
        'join must surface the setting-up error once the wait deadline passes'
    );
    win.close();
});
