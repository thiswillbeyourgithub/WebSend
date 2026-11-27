import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { makeSessionPair } from '../support/session-keys.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/crypto.js');

// crypto.js uses btoa/TextEncoder/TextDecoder — ensure they're global
globalThis.btoa = globalThis.btoa ?? (b => Buffer.from(b, 'binary').toString('base64'));
globalThis.atob = globalThis.atob ?? (b => Buffer.from(b, 'base64').toString('binary'));

const win = await loadBrowserModule(modulePath, {
    TextEncoder,
    TextDecoder,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
});
const C = win.WebSendCrypto;

// ---- getRandomBytes ----

test('getRandomBytes: returns correct length', () => {
    const buf = C.getRandomBytes(100);
    assert.equal(buf.length, 100);
});

test('getRandomBytes: handles size > 65536 (multi-chunk)', () => {
    const buf = C.getRandomBytes(200_000);
    assert.equal(buf.length, 200_000);
    // Sanity: not all zeros (extremely unlikely with random data)
    const nonZero = buf.some(b => b !== 0);
    assert.ok(nonZero);
});

// ---- sha256Hex ----

test('sha256Hex: known vector (empty input)', async () => {
    const hex = await C.sha256Hex(new ArrayBuffer(0));
    assert.equal(hex, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256Hex: deterministic for same input', async () => {
    const data = new TextEncoder().encode('hello').buffer;
    const h1 = await C.sha256Hex(data);
    const h2 = await C.sha256Hex(data);
    assert.equal(h1, h2);
});

// ---- public key validation ----

test('importPublicKey: rejects malformed keys before WebCrypto', async () => {
    const kp = await C.generateKeyPair();
    const good = await C.exportPublicKey(kp.publicKey);
    assert.equal(C.decodePublicKeyBytes(good).length, 65);
    await assert.rejects(() => C.importPublicKey('not base64!'));
    await assert.rejects(() => C.importPublicKey('A'.repeat(300)));
    await assert.rejects(() => C.importPublicKey(12));
    // 65 bytes but compressed-point prefix instead of 0x04
    const bad = Buffer.from(Buffer.from(good, 'base64').map((b, i) => (i === 0 ? 0x02 : b))).toString('base64');
    await assert.rejects(() => C.importPublicKey(bad));
    // wrong length (33 bytes)
    await assert.rejects(() => C.importPublicKey(Buffer.alloc(33, 4).toString('base64')));
});

// ---- QR secret K ----

test('generateQrSecret: 22-char base64url decoding to 16 bytes', () => {
    const k = C.generateQrSecret();
    assert.match(k, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(C.isQrSecret(k), true);
    assert.equal(C.decodeQrSecret(k).length, 16);
    assert.notEqual(C.generateQrSecret(), k);
});

test('decodeQrSecret: round-trips known bytes and rejects bad input', () => {
    // bytes 0xfb 0xff ... exercise the url-safe '-' / '_' mapping
    const raw = Buffer.from([0xfb, 0xff, 0xbf, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const k = raw.toString('base64url');
    assert.equal(k.length, 22);
    assert.deepEqual(Buffer.from(C.decodeQrSecret(k)), raw);
    assert.equal(C.isQrSecret(k + 'A'), false);
    assert.equal(C.isQrSecret(k.slice(0, 21) + '+'), false);
    assert.equal(C.isQrSecret(null), false);
    assert.throws(() => C.decodeQrSecret('short'));
});

// ---- session derivation + key-confirm ----

/** Receiver/sender session handles (see test/support/session-keys.mjs). */
async function makePair(crypto_ = C, override = {}) {
    const { receiverKeys: receiver, senderKeys: sender } = await makeSessionPair(crypto_, override);
    return { receiver, sender };
}

test('key-confirm: matching bindings open in both directions', async () => {
    const { receiver, sender } = await makePair();
    const r2s = await receiver.sealKeyConfirm('receiver-to-sender');
    const s2r = await sender.sealKeyConfirm('sender-to-receiver');
    assert.equal(await sender.openKeyConfirm('receiver-to-sender', r2s), true);
    assert.equal(await receiver.openKeyConfirm('sender-to-receiver', s2r), true);
});

test('key-confirm: a confirm never opens as the other direction (no reflection)', async () => {
    const { receiver, sender } = await makePair();
    const r2s = await receiver.sealKeyConfirm('receiver-to-sender');
    // An attacker reflecting the receiver's own confirm back to it
    assert.equal(await receiver.openKeyConfirm('sender-to-receiver', r2s), false);
    assert.equal(await sender.openKeyConfirm('sender-to-receiver', r2s), false);
});

test('key-confirm: a different K on one side changes the keys (confirm fails)', async () => {
    const { receiver, sender } = await makePair(C, { sender: { qrSecret: C.generateQrSecret() } });
    const s2r = await sender.sealKeyConfirm('sender-to-receiver');
    assert.equal(await receiver.openKeyConfirm('sender-to-receiver', s2r), false);
});

test('key-confirm: swapped public-key order fails', async () => {
    // Same ECDH secret and K, but the sender binds the keys in the wrong
    // role order: the master key differs, so the confirm must not open.
    const kpR = await C.generateKeyPair();
    const kpS = await C.generateKeyPair();
    const pubR = await C.exportPublicKey(kpR.publicKey);
    const pubS = await C.exportPublicKey(kpS.publicKey);
    const qrSecret = C.generateQrSecret();
    const receiver = await C.deriveSessionKeys(kpR.privateKey, await C.importPublicKey(pubS),
        { receiverPub: pubR, senderPub: pubS, qrSecret });
    const sender = await C.deriveSessionKeys(kpS.privateKey, await C.importPublicKey(pubR),
        { receiverPub: pubS, senderPub: pubR, qrSecret });
    const s2r = await sender.sealKeyConfirm('sender-to-receiver');
    assert.equal(await receiver.openKeyConfirm('sender-to-receiver', s2r), false);
});

test('key-confirm: MITM-substituted public key fails even with the right K', async () => {
    // The MITM relays its own key M to the receiver as "sender" and to the
    // sender as "receiver". Even if M somehow knew K, each honest side binds
    // the keys it saw, so the confirms cannot line up across the two halves.
    const kpR = await C.generateKeyPair();
    const kpS = await C.generateKeyPair();
    const kpM = await C.generateKeyPair();
    const [pubR, pubS, pubM] = await Promise.all([kpR, kpS, kpM].map(k => C.exportPublicKey(k.publicKey)));
    const qrSecret = C.generateQrSecret();
    const receiver = await C.deriveSessionKeys(kpR.privateKey, await C.importPublicKey(pubM),
        { receiverPub: pubR, senderPub: pubM, qrSecret });
    const sender = await C.deriveSessionKeys(kpS.privateKey, await C.importPublicKey(pubM),
        { receiverPub: pubM, senderPub: pubS, qrSecret });
    const s2r = await sender.sealKeyConfirm('sender-to-receiver');
    assert.equal(await receiver.openKeyConfirm('sender-to-receiver', s2r), false);
});

test('key-confirm: garbage and tampered ciphertexts are rejected', async () => {
    const { receiver, sender } = await makePair();
    const s2r = await sender.sealKeyConfirm('sender-to-receiver');
    const bytes = Buffer.from(s2r, 'base64');
    bytes[bytes.length - 1] ^= 1;
    assert.equal(await receiver.openKeyConfirm('sender-to-receiver', bytes.toString('base64')), false);
    assert.equal(await receiver.openKeyConfirm('sender-to-receiver', 'AAAA'), false);
    assert.equal(await receiver.openKeyConfirm('sender-to-receiver', '!!!'), false);
    await assert.rejects(() => receiver.openKeyConfirm('sideways', s2r));
});

test('deriveSessionKeys: refuses a missing or malformed binding', async () => {
    const kp = await C.generateKeyPair();
    const pub = await C.exportPublicKey(kp.publicKey);
    const imported = await C.importPublicKey(pub);
    await assert.rejects(() => C.deriveSessionKeys(kp.privateKey, imported));
    await assert.rejects(() => C.deriveSessionKeys(kp.privateKey, imported,
        { receiverPub: pub, senderPub: pub, qrSecret: 'tooshort' }));
    await assert.rejects(() => C.deriveSessionKeys(kp.privateKey, imported,
        { receiverPub: pub, senderPub: 'x', qrSecret: C.generateQrSecret() }));
});

test('deriveFileKey: K changes the file key', async () => {
    const same = await makePair();
    const diff = await makePair(C, { sender: { qrSecret: C.generateQrSecret() } });
    const data = new Uint8Array([1, 2, 3]);
    const ctSame = await C.sealSegment(await same.sender.deriveFileKey(new Uint8Array(16)), 0, true, data);
    const out = await C.openSegment(await same.receiver.deriveFileKey(new Uint8Array(16)), 0, true, ctSame);
    assert.deepEqual(new Uint8Array(out), data);
    const ctDiff = await C.sealSegment(await diff.sender.deriveFileKey(new Uint8Array(16)), 0, true, data);
    const wrongKey = await diff.receiver.deriveFileKey(new Uint8Array(16));
    await assert.rejects(() => C.openSegment(wrongKey, 0, true, ctDiff));
});

// ---- v2 chunked AEAD segments (STREAM construction) ----
//
// A second module instance with the compression globals injected so the
// per-segment gzip path is exercised (the default instance above has no
// CompressionStream, which doubles as coverage of the graceful fallback).
const winGz = await loadBrowserModule(modulePath, {
    TextEncoder,
    TextDecoder,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    Blob,
    Response,
    CompressionStream,
    DecompressionStream,
});
const CG = winGz.WebSendCrypto;

/**
 * Derive matching session key handles for both peers plus a shared file
 * key from one salt, mirroring a real sender/receiver pair.
 */
async function makeFileKeyPair(crypto_, salt) {
    const { receiver: keysA, sender: keysB } = await makePair(crypto_);
    return {
        keysA,
        keysB,
        fileKeyA: await keysA.deriveFileKey(salt),
        fileKeyB: await keysB.deriveFileKey(salt),
    };
}

function patternedBytes(size) {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = i % 251;
    return buf;
}

const SALT = new Uint8Array(16).fill(7);

test('buildSegmentNonce: known vector (BE seq + final flag)', () => {
    assert.deepEqual(
        Array.from(C.buildSegmentNonce(0x01020304, true)),
        [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 1]);
    assert.deepEqual(
        Array.from(C.buildSegmentNonce(0, false)),
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('buildSegmentNonce: rejects out-of-range seq', () => {
    assert.throws(() => C.buildSegmentNonce(-1, false));
    assert.throws(() => C.buildSegmentNonce(2 ** 32, false));
    assert.throws(() => C.buildSegmentNonce(1.5, false));
});

test('deriveFileKey: rejects bad salts', async () => {
    const { keysA } = await makeFileKeyPair(C, SALT);
    await assert.rejects(async () => keysA.deriveFileKey(new Uint8Array(15)));
    await assert.rejects(async () => keysA.deriveFileKey('0123456789abcdef'));
});

test('sealSegment/openSegment round-trip across peers (no gzip)', async () => {
    const { fileKeyA, fileKeyB } = await makeFileKeyPair(C, SALT);
    const data = patternedBytes(1000);
    const ct = await C.sealSegment(fileKeyA, 3, false, data);
    const out = await C.openSegment(fileKeyB, 3, false, ct);
    assert.deepEqual(new Uint8Array(out), data);
});

test('sealSegment/openSegment round-trip with gzip on compressible data', async () => {
    const { fileKeyA, fileKeyB } = await makeFileKeyPair(CG, SALT);
    const data = new Uint8Array(64 * 1024).fill(97); // 64 KiB of "a"
    const ct = await CG.sealSegment(fileKeyA, 1, false, data, { tryGzip: true });
    assert.ok(ct.byteLength < data.length / 2, 'compressible data must shrink on the wire');
    const out = await CG.openSegment(fileKeyB, 1, false, ct);
    assert.deepEqual(new Uint8Array(out), data);
});

test('sealSegment: tryGzip without CompressionStream falls back to raw', async () => {
    const { fileKeyA, fileKeyB } = await makeFileKeyPair(C, SALT);
    const data = new Uint8Array(4096).fill(97);
    const ct = await C.sealSegment(fileKeyA, 1, false, data, { tryGzip: true });
    assert.ok(ct.byteLength >= data.length, 'no CompressionStream in this realm, must send raw');
    const out = await C.openSegment(fileKeyB, 1, false, ct);
    assert.deepEqual(new Uint8Array(out), data);
});

test('sealSegment: padToSize pads with random bytes and openSegment strips it', async () => {
    const { fileKeyA, fileKeyB } = await makeFileKeyPair(C, SALT);
    const data = patternedBytes(100);
    const ct = await C.sealSegment(fileKeyA, 2, true, data, { padToSize: 16384 });
    assert.equal(ct.byteLength, 16384 + 16, 'plaintext padded to bucket, plus GCM tag');
    const out = await C.openSegment(fileKeyB, 2, true, ct);
    assert.deepEqual(new Uint8Array(out), data);
});

test('sealSegment: padToSize smaller than data is ignored', async () => {
    const { fileKeyA, fileKeyB } = await makeFileKeyPair(C, SALT);
    const data = patternedBytes(1024);
    const ct = await C.sealSegment(fileKeyA, 2, false, data, { padToSize: 64 });
    const out = await C.openSegment(fileKeyB, 2, false, ct);
    assert.deepEqual(new Uint8Array(out), data);
});

test('openSegment: empty payload round-trips', async () => {
    const { fileKeyA, fileKeyB } = await makeFileKeyPair(C, SALT);
    const ct = await C.sealSegment(fileKeyA, 1, true, new Uint8Array(0));
    const out = await C.openSegment(fileKeyB, 1, true, ct);
    assert.equal(out.byteLength, 0);
});

test('openSegment rejects a tampered segment (bit flip)', async () => {
    const { fileKeyA, fileKeyB } = await makeFileKeyPair(C, SALT);
    const ct = new Uint8Array(await C.sealSegment(fileKeyA, 1, false, patternedBytes(500)));
    ct[100] ^= 0x01;
    await assert.rejects(() => C.openSegment(fileKeyB, 1, false, ct));
});

test('openSegment rejects a reordered segment (wrong seq)', async () => {
    const { fileKeyA, fileKeyB } = await makeFileKeyPair(C, SALT);
    const ct = await C.sealSegment(fileKeyA, 1, false, patternedBytes(500));
    await assert.rejects(() => C.openSegment(fileKeyB, 2, false, ct));
});

test('openSegment rejects truncation (non-final segment opened as final and vice versa)', async () => {
    const { fileKeyA, fileKeyB } = await makeFileKeyPair(C, SALT);
    const data = patternedBytes(500);
    const nonFinal = await C.sealSegment(fileKeyA, 1, false, data);
    await assert.rejects(() => C.openSegment(fileKeyB, 1, true, nonFinal),
        'a middle segment must not be accepted as the end of the file');
    const final = await C.sealSegment(fileKeyA, 2, true, data);
    await assert.rejects(() => C.openSegment(fileKeyB, 2, false, final));
});

test('openSegment rejects a segment sealed under a different file salt (re-key)', async () => {
    const { keysA, keysB } = await makeFileKeyPair(C, SALT);
    const saltOld = new Uint8Array(16).fill(1);
    const saltNew = new Uint8Array(16).fill(2);
    const data = patternedBytes(500);
    const ctOld = await C.sealSegment(await keysA.deriveFileKey(saltOld), 5, false, data);
    const ctNew = await C.sealSegment(await keysA.deriveFileKey(saltNew), 5, false, data);
    assert.notDeepEqual(new Uint8Array(ctOld), new Uint8Array(ctNew),
        'rewind re-key must change the ciphertext for the same seq and plaintext');
    const newKeyB = await keysB.deriveFileKey(saltNew);
    await assert.rejects(
        () => C.openSegment(newKeyB, 5, false, ctOld),
        'old-salt segments must not open under the new key');
});

// ---- composite hash ----

test('finalizeCompositeHash: deterministic and equal to sha256 of concatenated digests', async () => {
    const d1 = await C.sha256Bytes(patternedBytes(100));
    const d2 = await C.sha256Bytes(patternedBytes(200));
    const all = new Uint8Array(64);
    all.set(d1, 0);
    all.set(d2, 32);
    const expected = await C.sha256Hex(all);
    assert.equal(await C.finalizeCompositeHash([d1, d2]), expected);
    assert.match(expected, /^[0-9a-f]{64}$/);
});

test('finalizeCompositeHash: order matters and bad digests are rejected', async () => {
    const d1 = await C.sha256Bytes(patternedBytes(100));
    const d2 = await C.sha256Bytes(patternedBytes(200));
    assert.notEqual(
        await C.finalizeCompositeHash([d1, d2]),
        await C.finalizeCompositeHash([d2, d1]));
    await assert.rejects(() => C.finalizeCompositeHash([new Uint8Array(31)]));
});
