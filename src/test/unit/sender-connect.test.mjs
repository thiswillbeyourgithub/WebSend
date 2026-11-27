/**
 * Unit tests for js/sender-connect.js. Loads the REAL crypto.js,
 * protocol.js and pairing.js into the jsdom realm and drives the sender
 * against a real receiver-side Pairing, so the key-confirm gate is
 * exercised end to end: premature `ready` deferred until bound, a
 * mid-session re-key refused, a duplicate same-key public-key answered
 * idempotently, a wrong QR secret aborting the session, plus the
 * transform-nack cap, recovery and reconnect queue behaviour.
 *
 * Built with Claude Code (Opus 5.5).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsDir = path.resolve(__dirname, '../../public/js');
const sources = ['crypto.js', 'protocol.js', 'pairing.js', 'sender-connect.js']
    .map((f) => readFileSync(path.join(jsDir, f), 'utf8'));

// Pairings arm a 30 s key-confirm timer; reset every pairing created by a
// test so a pending timer never keeps the runner alive.
const live = [];
afterEach(() => {
    while (live.length) live.pop()();
});

function setup() {
    const dom = new JSDOM(
        '<!doctype html><html><body>' +
        '<div id="connection-status"></div>' +
        '<div id="step-connecting"></div>' +
        '</body></html>',
        { runScripts: 'outside-only', url: 'http://localhost/' }
    );
    const win = dom.window;
    // jsdom has no SubtleCrypto: lend it Node's WebCrypto.
    Object.defineProperty(win, 'crypto', { value: globalThis.crypto, configurable: true });
    win.TextEncoder = globalThis.TextEncoder;
    win.TextDecoder = globalThis.TextDecoder;
    // crypto.js logs through the page-global logger.
    win.logger = { info() {}, warn() {}, error() {}, success() {} };

    win.WebSendRTC = class {
        constructor() { this.iceServers = []; this.sent = []; this.closed = false; }
        async init() {}
        async joinRoom() {}
        sendMessage(m) { this.sent.push(m); return true; }
        close() { this.closed = true; }
    };
    win.Transport = {
        createForSender: () => new win.WebSendRTC(),
        createForReceiver: () => new win.WebSendRTC(),
    };
    win.PeerUI = { onConnectionTypeDetected: () => {}, showVerifiedInSidebar: () => {}, hasTurn: () => true };
    win.wakeLockMgr = { desired: false, acquire: async () => {}, release: () => {} };
    win.Gallery = { size: () => 0, shredLocal: () => {}, photos: () => [] };
    // Minimal SenderSend double; individual tests override the spies
    // they care about (drain kick on recovery, queue preservation on
    // reconnect).
    win.SenderSend = {
        push: () => {},
        size: () => 0,
        isActive: () => false,
        drain: () => {},
        clear: () => {},
        resetForReconnect: () => {},
    };

    const logs = { info: [], warn: [], error: [], success: [] };
    const toasts = [];
    let readyToCaptureCalled = 0;
    let pairedCalled = 0;
    let scanRequested = 0;

    for (const src of sources) new win.Function(src).call(win);
    live.push(() => win.SenderConnect.cleanup());

    win.SenderConnect.attach({
        i18n: { t: (k) => k },
        logger: {
            info: (m) => logs.info.push(m),
            warn: (m) => logs.warn.push(m),
            error: (m) => logs.error.push(m),
            success: (m) => logs.success.push(m),
        },
        showToast: (m, opts) => toasts.push({ m, opts }),
        onReadyToCapture: () => { readyToCaptureCalled++; },
        onPaired: () => { pairedCalled++; },
        onShowConnecting: () => {},
        onScanRequested: () => { scanRequested++; },
    });

    return {
        win,
        logs,
        toasts,
        getReadyToCaptureCalled: () => readyToCaptureCalled,
        getPairedCalled: () => pairedCalled,
        getScanRequested: () => scanRequested,
    };
}

/**
 * A receiver peer built on the real Pairing, as receive.html does it.
 * `qrSecret` is what the receiver printed in its QR; pass a different
 * one to the sender to model a MITM / wrong link.
 */
async function makeReceiver(win, qrSecret) {
    const keyPair = await win.WebSendCrypto.generateKeyPair();
    const pub = await win.WebSendCrypto.exportPublicKey(keyPair.publicKey);
    const pairing = win.Pairing.create({ role: 'receiver', keyPair, qrSecret });
    live.push(() => pairing.reset());
    return { keyPair, pub, pairing, publicKeyMsg: win.Protocol.build.publicKey(pub) };
}

const lastOfType = (rtc, type) => [...rtc.sent].reverse().find((m) => m && m.type === type);

/**
 * Sender joins with `senderK`, receiver announces its key, both exchange
 * key-confirms. Returns the pieces so tests can continue the dialogue.
 */
async function handshake(ctx, { receiverK, senderK } = {}) {
    const { win } = ctx;
    const K = receiverK || win.WebSendCrypto.generateQrSecret();
    const receiver = await makeReceiver(win, K);
    await win.SenderConnect.init();
    await win.SenderConnect.join('ROOM01', 'secret', senderK || K);
    const rtc = win.SenderConnect.getRtc();
    await rtc.onMessage(receiver.publicKeyMsg);
    const spk = lastOfType(rtc, 'sender-public-key');
    assert.ok(spk, 'sender answers with sender-public-key');
    assert.ok(lastOfType(rtc, 'key-confirm'), 'sender sends its key-confirm');
    const accepted = await receiver.pairing.acceptPeerKey(spk);
    assert.equal(accepted.status, 'derived');
    const receiverSide = await receiver.pairing.handleKeyConfirm(lastOfType(rtc, 'key-confirm'));
    return { rtc, receiver, receiverConfirm: accepted.confirmMsg, receiverSide };
}

test('join refuses an invite without a valid QR secret', async () => {
    const ctx = setup();
    await ctx.win.SenderConnect.init();
    await ctx.win.SenderConnect.join('ROOM01', 'secret', undefined);
    assert.ok(ctx.toasts.some((t) => t.m === 'send.invalidQR.outdatedLink'));
    assert.equal(ctx.getScanRequested(), 1);
    assert.equal(ctx.win.SenderConnect.getRtc().sent.length, 0, 'nothing sent for a refused invite');
});

test('matching K: both sides bind, ready opens capture only after the confirm', async () => {
    const ctx = setup();
    const { rtc, receiverConfirm, receiverSide } = await handshake(ctx);
    assert.equal(receiverSide.status, 'bound', 'receiver opens the sender confirm');

    // Premature ready (before the receiver confirm reached us): deferred.
    await rtc.onMessage({ type: 'ready', protocolVersion: 2 });
    assert.equal(ctx.win.SenderConnect.isVerified(), false);
    assert.equal(ctx.win.SenderConnect.getSessionKeys(), null, 'no session keys before bound');
    assert.equal(ctx.getReadyToCaptureCalled(), 0, 'ready must not open capture before bound');

    await rtc.onMessage(receiverConfirm);
    assert.equal(ctx.win.SenderConnect.isVerified(), true);
    assert.equal(ctx.getPairedCalled(), 1, 'pairing-confirmed UI fires once');
    assert.equal(ctx.getReadyToCaptureCalled(), 1, 'deferred ready is honoured once bound');
    assert.ok(ctx.win.SenderConnect.getSessionKeys(), 'session keys available once bound');
});

test('ready alone (no key-confirm ever) never opens capture', async () => {
    const ctx = setup();
    const { rtc } = await handshake(ctx);
    await rtc.onMessage({ type: 'ready', protocolVersion: 2 });
    assert.equal(ctx.win.SenderConnect.isVerified(), false);
    assert.equal(ctx.getReadyToCaptureCalled(), 0);
});

test('different K: receiver confirm fails, sender aborts and accepts nothing', async () => {
    const ctx = setup();
    const K1 = ctx.win.WebSendCrypto.generateQrSecret();
    const K2 = ctx.win.WebSendCrypto.generateQrSecret();
    const { rtc, receiverConfirm, receiverSide } = await handshake(ctx, { receiverK: K1, senderK: K2 });
    assert.equal(receiverSide.status, 'failed', 'receiver rejects the sender confirm');

    await rtc.onMessage(receiverConfirm);
    assert.equal(ctx.win.SenderConnect.isVerified(), false);
    assert.equal(ctx.win.SenderConnect.getSessionKeys(), null);
    assert.ok(ctx.toasts.some((t) => t.m === 'pairing.failed'), 'clear error shown');
    assert.ok(rtc.closed, 'connection closed on confirm failure');
    assert.equal(ctx.getScanRequested(), 1, 'user sent back to scanning');
    await rtc.onMessage({ type: 'ready', protocolVersion: 2 });
    assert.equal(ctx.getReadyToCaptureCalled(), 0, 'ready after a failure opens nothing');
});

test('version mismatch on public-key shows the reload error and derives nothing', async () => {
    const ctx = setup();
    const receiver = await makeReceiver(ctx.win, ctx.win.WebSendCrypto.generateQrSecret());
    await ctx.win.SenderConnect.init();
    await ctx.win.SenderConnect.join('ROOM01', 'secret', ctx.win.WebSendCrypto.generateQrSecret());
    const rtc = ctx.win.SenderConnect.getRtc();
    await rtc.onMessage({ ...receiver.publicKeyMsg, protocolVersion: 1 });
    assert.ok(ctx.toasts.some((t) => t.m === 'pairing.versionMismatch'));
    assert.equal(lastOfType(rtc, 'key-confirm'), undefined, 'no confirm for an incompatible peer');
});

test('handlePublicKey blocks a mid-session re-key with a different key', async () => {
    const ctx = setup();
    const { rtc, receiverConfirm } = await handshake(ctx);
    await rtc.onMessage(receiverConfirm);
    assert.equal(ctx.win.SenderConnect.isVerified(), true);

    const other = await makeReceiver(ctx.win, ctx.win.WebSendCrypto.generateQrSecret());
    const sentBefore = rtc.sent.length;
    await rtc.onMessage(other.publicKeyMsg);
    assert.equal(rtc.sent.length, sentBefore, 'nothing sent in reply to a refused re-key');
    assert.equal(ctx.win.SenderConnect.isVerified(), true, 'existing binding untouched');
    assert.equal(ctx.getPairedCalled(), 1);
    assert.ok(
        ctx.logs.warn.some(m => /unexpected public-key|already completed/i.test(m)),
        `warn log should mention the blocked re-key, got: ${JSON.stringify(ctx.logs.warn)}`
    );
    assert.ok(
        ctx.toasts.some(t => /rekey|re-key/i.test(t.m)),
        `a user-visible toast should fire, got: ${JSON.stringify(ctx.toasts)}`
    );
});

test('handlePublicKey re-sends reply idempotently for a DUPLICATE same-key public-key', async () => {
    const ctx = setup();
    const { rtc, receiver, receiverConfirm } = await handshake(ctx);
    await rtc.onMessage(receiverConfirm);

    // Second public-key carrying the SAME key: the receiver never got our
    // first reply (dropped before a race winner locked) and is re-sending.
    // Not an attack: re-send our public-key + confirm, keep the binding,
    // no re-key warning or toast.
    const sentBefore = rtc.sent.length;
    await rtc.onMessage(receiver.publicKeyMsg);
    const fresh = rtc.sent.slice(sentBefore);
    assert.ok(fresh.some(m => m && m.type === 'sender-public-key'), 'sender-public-key re-sent');
    assert.ok(fresh.some(m => m && m.type === 'key-confirm'), 'key-confirm re-sent');
    assert.equal(ctx.win.SenderConnect.isVerified(), true, 'binding kept');
    assert.equal(ctx.getPairedCalled(), 1, 'pairing UI must not re-fire on a duplicate');
    assert.ok(!ctx.logs.warn.some(m => /unexpected public-key|already completed/i.test(m)));
    assert.ok(!ctx.toasts.some(t => /rekey|re-key/i.test(t.m)));
});

test('handleTransformNack caps per-photo re-sends (anti-pin)', async () => {
    const ctx = setup();
    // Stand up a fake gallery with one already-sent photo. The hostile
    // peer will spam transform-nack for its hash; we expect at most
    // MAX_NACK_RETRIES_PER_PHOTO (2) pushes before the sender refuses.
    const photo = {
        id: 1,
        blob: new ctx.win.Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
        sentHash: 'a'.repeat(64),
        sendStatus: 'sent',
        transforms: [],
    };
    ctx.win.Gallery.photos = () => [photo];

    let pushCount = 0;
    ctx.win.SenderSend = {
        push: () => { pushCount++; },
        size: () => 0,
        drain: () => {},
    };

    await ctx.win.SenderConnect.init();
    const rtc = ctx.win.SenderConnect.getRtc();

    // Fire transform-nack 5 times in a row; only the first 2 should
    // result in a re-queue, the rest must be refused with an error log.
    for (let i = 0; i < 5; i++) {
        await rtc.onMessage({ type: 'transform-nack', oldHash: photo.sentHash, reason: 'spam' });
    }

    assert.equal(pushCount, 2,
        `expected at most 2 re-queues, got ${pushCount}`);
    assert.ok(
        ctx.logs.error.some(m => /refusing to re-send.*more than/i.test(m)),
        `error log should mention the cap, got: ${JSON.stringify(ctx.logs.error)}`
    );
});

// Regression: a drop + recovery while the wizard sat on the connecting
// step (classically: the connection died while the OS file picker was
// open) used to dead-end the UI on a "Connected" status with only a
// stale "Back to scan" button, with no way to pick a file again.
test('connection recovery removes the stale retry button and restores the capture step', async () => {
    const ctx = setup();
    const { win } = ctx;
    let drains = 0;
    win.SenderSend = {
        push: () => {}, clear: () => {}, resetForReconnect: () => {},
        size: () => 1,
        isActive: () => false,
        drain: () => { drains++; },
    };
    // Complete pairing: public-key, key-confirms, ready.
    const { rtc, receiverConfirm } = await handshake(ctx);
    await rtc.onMessage(receiverConfirm);
    await rtc.onMessage({ type: 'ready', protocolVersion: 2 });
    assert.equal(ctx.getReadyToCaptureCalled(), 1, 'paired session reaches the capture step');

    // Transport failure dumps the user onto the connecting step with a
    // retry button.
    rtc.onStateChange('failed');
    assert.ok(win.document.getElementById('error-retry-btn'),
        'the failure path must offer the back-to-scan button');

    // Recovery: state flips back to connected while step-connecting is
    // still the visible step (no hidden class in this DOM).
    const drainsBefore = drains;
    rtc.onStateChange('connected');
    assert.equal(win.document.getElementById('error-retry-btn'), null,
        'the stale retry button must be removed on recovery');
    assert.equal(ctx.getReadyToCaptureCalled(), 2,
        'the wizard must return to the capture step instead of dead-ending');
    assert.ok(drains > drainsBefore, 'files queued while down must drain after recovery');
});

test('reconnect() preserves the send queue via resetForReconnect instead of clearing it', async () => {
    const ctx = setup();
    const { win } = ctx;
    let resets = 0;
    let clears = 0;
    win.SenderSend = {
        push: () => {}, size: () => 0, isActive: () => false, drain: () => {},
        clear: () => { clears++; },
        resetForReconnect: () => { resets++; },
    };
    await win.SenderConnect.init();
    await win.SenderConnect.join('ROOM01', 'secret', win.WebSendCrypto.generateQrSecret());
    await win.SenderConnect.reconnect();
    assert.equal(resets, 1, 'resetForReconnect must run so queued blobs re-key with the new session');
    assert.equal(clears, 0, 'files picked while the transport was down must not be wiped');
});
