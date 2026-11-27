/**
 * Unit tests for the CLI receiver's data-channel session (cli/shim.js
 * createSession): the QR-secret key-confirm gate. Loads the real
 * crypto.js, protocol.js, pairing.js, segment-stream.js and shim.js into
 * one vm context and drives the session with a real sender-side Pairing,
 * so the gate is exercised end to end without WebRTC or Playwright.
 *
 * Built with Claude Code (Opus 5.5).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { loadPairingWindow } from '../support/pairing-peers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = await loadPairingWindow();
const { WebSendCrypto: C, Protocol: P, Pairing } = base;
// segment-stream.js reads WebSendCrypto / Protocol as bare globals, so the
// second context gets them (and Pairing, for shim.js) injected.
const win = await loadBrowserModule(
    [
        path.resolve(__dirname, '../../public/js/segment-stream.js'),
        path.resolve(__dirname, '../../cli/shim.js'),
    ],
    {
        WebSendCrypto: C, Protocol: P, Pairing,
        TextEncoder, TextDecoder, btoa: globalThis.btoa, atob: globalThis.atob,
        Blob, Response, CompressionStream, DecompressionStream,
        __nodeLog: () => {},
    },
);
const SS = win.SegmentStream;
const { createSession } = win.__wsCli;

// Pairings arm a 30 s key-confirm timer: reset them all after each test.
const live = [];
afterEach(() => { while (live.length) live.pop()(); });

/**
 * A CLI session plus a sender Pairing. The sender holds `senderK`
 * (defaults to the same K as the CLI, i.e. it scanned the real URL).
 */
async function setup({ senderK } = {}) {
    const K = C.generateQrSecret();
    const kpR = await C.generateKeyPair();
    const kpS = await C.generateKeyPair();
    const sent = [];
    const saved = [];
    const io = { closed: 0, done: [] };
    const session = createSession({
        keyPair: kpR,
        qrSecret: K,
        send: (m) => sent.push(m),
        close: () => { io.closed++; },
        done: (s) => io.done.push(s),
        saveFile: async (name, mime, b64) => { saved.push({ name, mime, b64 }); return name; },
    });
    const sender = Pairing.create({ role: 'sender', keyPair: kpS, qrSecret: senderK || K });
    live.push(() => { session.dispose(); sender.reset(); });
    const rPubMsg = P.build.publicKey(await C.exportPublicKey(kpR.publicKey));
    const sPubMsg = P.build.senderPublicKey(await C.exportPublicKey(kpS.publicKey));
    const deliver = (m) => session.onMessage(JSON.stringify(m));
    return { session, sender, sent, saved, io, rPubMsg, sPubMsg, deliver, K };
}

/** Run the full exchange: both public keys, then both key-confirms. */
async function handshake(t) {
    const sRes = await t.sender.acceptPeerKey(t.rPubMsg);
    await t.deliver(t.sPubMsg);
    const rConfirm = t.sent.find((m) => m.type === 'key-confirm');
    assert.ok(rConfirm, 'CLI answers the sender key with its key-confirm');
    await t.sender.handleKeyConfirm(rConfirm);
    await t.deliver(sRes.confirmMsg);
}

/** Seal `bytes` as one v2 file and return the messages / records to deliver. */
async function sealFile(sessionKeys, bytes, name) {
    const s = await SS.createSender({
        blob: new Blob([bytes]),
        metadata: { name, mimeType: 'text/plain', originalSize: bytes.length },
        sessionKeys,
    });
    const records = [];
    for (let r = await s.next(); r; r = await s.next()) records.push(r.bytes);
    return { start: P.build.fileStartV2(s.segCount, s.saltB64), records };
}

test('file-start before pairing is dropped and binary aborts the peer', async () => {
    const t = await setup();
    await t.deliver(P.build.fileStartV2(1, C.generateQrSecret()));
    assert.equal(t.sent.length, 0, 'no nack, no state change');
    await t.session.onMessage(new Uint8Array(32).buffer);
    assert.equal(t.io.closed, 1);
    assert.equal(t.io.done[0].abusive, true);
});

test('matching K binds, sends ready, and a file is saved', async () => {
    const t = await setup();
    await handshake(t);
    assert.equal(t.session.isBound(), true);
    assert.equal(t.sender.isBound(), true);
    assert.ok(t.sent.some((m) => m.type === 'ready'), 'ready only after bound');

    const text = new TextEncoder().encode('hello from the phone');
    const f = await sealFile(t.sender.getSessionKeys(), text, 'note.txt');
    await t.deliver(f.start);
    for (const r of f.records) await t.session.onMessage(r);
    await t.deliver(P.build.fileEnd());

    assert.equal(t.saved.length, 1);
    assert.equal(t.saved[0].name, 'note.txt');
    assert.equal(Buffer.from(t.saved[0].b64, 'base64').toString(), 'hello from the phone');
    assert.ok(t.sent.some((m) => m.type === 'file-ack'));
});

test('a sender with a different K never binds and is disconnected', async () => {
    const t = await setup({ senderK: C.generateQrSecret() });
    await handshake(t);
    assert.equal(t.session.isBound(), false);
    assert.equal(t.io.closed, 1, 'confirm mismatch closes the connection');
    assert.ok(!t.sent.some((m) => m.type === 'ready'));
    await t.deliver(P.build.fileStartV2(1, C.generateQrSecret()));
    assert.ok(!t.sent.some((m) => m.type === 'file-nack'), 'file-start still gated');
});

test('a new sender key mid-session drops the binding until a fresh confirm', async () => {
    const t = await setup();
    await handshake(t);
    assert.equal(t.session.isBound(), true);

    const other = await C.generateKeyPair();
    await t.deliver(P.build.senderPublicKey(await C.exportPublicKey(other.publicKey)));
    assert.equal(t.session.isBound(), false);
    await t.session.onMessage(new Uint8Array(32).buffer);
    assert.equal(t.io.done[0].abusive, true, 'binary after re-key is refused');
});

test('a protocol version mismatch closes without deriving', async () => {
    const t = await setup();
    await t.deliver({ ...t.sPubMsg, protocolVersion: P.VERSION + 1 });
    assert.equal(t.io.closed, 1);
    assert.ok(!t.sent.some((m) => m.type === 'key-confirm'));
});
