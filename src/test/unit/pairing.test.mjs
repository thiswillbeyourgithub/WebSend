/**
 * Pairing state machine (public/js/pairing.js): the encrypted key-confirm
 * that replaced the human verification code. Runs the real crypto.js and
 * protocol.js in one vm context and wires two Pairing instances together
 * the way receive.html / sender-connect.js do.
 *
 * Built with Claude Code (Opus 5.5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPairingWindow, makePairingPeers } from '../support/pairing-peers.mjs';

const win = await loadPairingWindow();
const { WebSendCrypto: C, Protocol: P, Pairing } = win;
const makePeers = (opts) => makePairingPeers(win, opts);

/** Run the full exchange: keys both ways, then confirms both ways. */
async function exchange(p) {
    const s = await p.sender.acceptPeerKey(p.rPubMsg);
    const r = await p.receiver.acceptPeerKey(p.sPubMsg);
    assert.equal(s.status, 'derived');
    assert.equal(r.status, 'derived');
    const toReceiver = await p.receiver.handleKeyConfirm(s.confirmMsg);
    const toSender = await p.sender.handleKeyConfirm(r.confirmMsg);
    return { s, r, toReceiver, toSender };
}

test('same K: both sides bind and expose session keys', async () => {
    const p = await makePeers();
    assert.equal(p.receiver.getSessionKeys(), null);
    const { toReceiver, toSender } = await exchange(p);
    assert.equal(toReceiver.status, 'bound');
    assert.equal(toSender.status, 'bound');
    assert.equal(p.receiver.isBound(), true);
    assert.equal(p.sender.isBound(), true);
    assert.deepEqual(p.events, { receiver: ['bound'], sender: ['bound'] });
    // Session keys interoperate: sender seals, receiver opens
    const salt = new Uint8Array(16);
    const ct = await C.sealSegment(await p.sender.getSessionKeys().deriveFileKey(salt), 0, true, new Uint8Array([9]));
    const pt = await C.openSegment(await p.receiver.getSessionKeys().deriveFileKey(salt), 0, true, ct);
    assert.deepEqual(new Uint8Array(pt), new Uint8Array([9]));
});

test('different K: confirm fails, no keys exposed, onFailed fires', async () => {
    const p = await makePeers({ senderK: C.generateQrSecret() });
    const { toReceiver, toSender } = await exchange(p);
    assert.equal(toReceiver.status, 'failed');
    assert.equal(toSender.status, 'failed');
    assert.equal(p.receiver.getSessionKeys(), null);
    assert.equal(p.sender.getSessionKeys(), null);
    assert.deepEqual(p.events.receiver, ['failed:confirm-mismatch']);
    // Failure is terminal for this peer key: a later confirm cannot bind
    assert.equal((await p.receiver.handleKeyConfirm(toSender)).status, 'failed');
});

test('key-confirm arriving before derivation finishes is buffered', async () => {
    const p = await makePeers();
    const s = await p.sender.acceptPeerKey(p.rPubMsg);
    // Receiver gets the confirm before it has processed sender-public-key
    assert.equal((await p.receiver.handleKeyConfirm(s.confirmMsg)).status, 'pending');
    assert.equal(p.receiver.isBound(), false);
    await p.receiver.acceptPeerKey(p.sPubMsg);
    // processConfirm runs fire-and-forget after derivation
    await new Promise(r => setTimeout(r, 50));
    assert.equal(p.receiver.isBound(), true);
    assert.deepEqual(p.events.receiver, ['bound']);
});

test('protocol version mismatch is refused without deriving', async () => {
    const p = await makePeers();
    const old = { ...p.rPubMsg, protocolVersion: 1 };
    assert.equal((await p.sender.acceptPeerKey(old)).status, 'version-mismatch');
    const missing = { type: 'public-key', key: p.rPubMsg.key };
    assert.equal((await p.sender.acceptPeerKey(missing)).status, 'version-mismatch');
    assert.equal(p.sender.hasPeerKey(), false);
});

test('invalid public key is refused', async () => {
    const p = await makePeers();
    const bad = P.build.publicKey('AAAA');
    assert.equal((await p.sender.acceptPeerKey(bad)).status, 'invalid-key');
});

test('duplicate same key keeps the binding and re-seals our confirm', async () => {
    const p = await makePeers();
    await exchange(p);
    const again = await p.sender.acceptPeerKey(p.rPubMsg);
    assert.equal(again.status, 'same-key');
    assert.equal(p.sender.isBound(), true);
    // The re-sealed confirm still binds idempotently on the other side
    const r = await p.receiver.handleKeyConfirm(again.confirmMsg);
    assert.equal(r.status, 'bound');
    assert.equal(r.newlyBound, false);
});

test('different peer key unbinds synchronously and needs a fresh confirm', async () => {
    const p = await makePeers();
    await exchange(p);
    const other = await C.generateKeyPair();
    const otherMsg = P.build.senderPublicKey(await C.exportPublicKey(other.publicKey));
    const pending = p.receiver.acceptPeerKey(otherMsg);
    // Before any await resolves the gate is already closed
    assert.equal(p.receiver.isBound(), false);
    assert.equal(p.receiver.getSessionKeys(), null);
    const res = await pending;
    assert.equal(res.status, 'derived');
    assert.equal(res.rekey, true);
    assert.equal(p.receiver.isBound(), false);
});

test('bad confirm on an already bound session is ignored', async () => {
    const p = await makePeers();
    await exchange(p);
    // The receiver's own confirm reflected back at it never opens
    const reflected = await p.receiver.acceptPeerKey(p.sPubMsg);
    const r = await p.receiver.handleKeyConfirm(reflected.confirmMsg);
    assert.equal(r.status, 'ignored');
    assert.equal(p.receiver.isBound(), true);
});

test('no confirm within the timeout fails pairing', async () => {
    const p = await makePeers({ timeoutMs: 20 });
    await p.receiver.acceptPeerKey(p.sPubMsg);
    await new Promise(r => setTimeout(r, 60));
    assert.deepEqual(p.events.receiver, ['failed:timeout']);
    assert.equal(p.receiver.hasFailed(), true);
});

test('reset clears everything (timer included)', async () => {
    const p = await makePeers({ timeoutMs: 20 });
    await exchange(p);
    p.receiver.reset();
    assert.equal(p.receiver.isBound(), false);
    assert.equal(p.receiver.hasPeerKey(), false);
    await p.receiver.acceptPeerKey(p.sPubMsg);
    p.receiver.reset();
    await new Promise(r => setTimeout(r, 60));
    assert.deepEqual(p.events.receiver, ['bound']);
});

test('create refuses a missing/invalid K and unknown role', async () => {
    const kp = await C.generateKeyPair();
    assert.throws(() => Pairing.create({ role: 'receiver', keyPair: kp, qrSecret: 'nope' }));
    assert.throws(() => Pairing.create({ role: 'relay', keyPair: kp, qrSecret: C.generateQrSecret() }));
});
