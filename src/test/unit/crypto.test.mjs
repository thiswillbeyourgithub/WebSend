import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
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

// ---- PADDING ----

test('PADDING_BUCKETS is monotonically increasing', () => {
    for (let i = 1; i < C.PADDING_BUCKETS.length; i++) {
        assert.ok(C.PADDING_BUCKETS[i] > C.PADDING_BUCKETS[i - 1],
            `Bucket ${i} not larger than bucket ${i - 1}`);
    }
});

test('getPaddedSize: 1 byte returns smallest bucket', () => {
    assert.equal(C.getPaddedSize(1), C.PADDING_BUCKETS[0]);
});

test('getPaddedSize: exactly at bucket boundary', () => {
    const bucket = C.PADDING_BUCKETS[2]; // 256 KB
    assert.equal(C.getPaddedSize(bucket), bucket);
});

test('getPaddedSize: one byte over bucket returns next bucket', () => {
    const bucket = C.PADDING_BUCKETS[2];
    assert.equal(C.getPaddedSize(bucket + 1), C.PADDING_BUCKETS[3]);
});

test('getPaddedSize: size beyond max bucket rounds to multiple of max', () => {
    const max = C.PADDING_BUCKETS[C.PADDING_BUCKETS.length - 1];
    const oversized = max * 2 + 1;
    const result = C.getPaddedSize(oversized);
    assert.equal(result % max, 0);
    assert.ok(result >= oversized);
});

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

// ---- encrypt / decrypt ----

test('encrypt/decrypt round-trip', async () => {
    const kp1 = await C.generateKeyPair();
    const kp2 = await C.generateKeyPair();
    const pub1 = await C.exportPublicKey(kp1.publicKey);
    const importedPub1 = await C.importPublicKey(pub1);
    const key = await C.deriveSharedKey(kp2.privateKey, importedPub1);

    const original = new TextEncoder().encode('secret message').buffer;
    const encrypted = await C.encrypt(original, key);
    const decrypted = await C.decrypt(encrypted, key);

    assert.deepEqual(new Uint8Array(decrypted), new Uint8Array(original));
});

test('decrypt rejects tampered ciphertext (tag mismatch)', async () => {
    const kp1 = await C.generateKeyPair();
    const kp2 = await C.generateKeyPair();
    const pub1 = await C.exportPublicKey(kp1.publicKey);
    const importedPub1 = await C.importPublicKey(pub1);
    const key = await C.deriveSharedKey(kp2.privateKey, importedPub1);

    const original = new TextEncoder().encode('tamper test').buffer;
    const encrypted = await C.encrypt(original, key);

    // Flip a byte in the ciphertext body (after the 12-byte IV)
    const tampered = new Uint8Array(encrypted);
    tampered[20] ^= 0xff;

    await assert.rejects(() => C.decrypt(tampered.buffer, key));
});

// ---- deriveSharedKey symmetry ----

test('deriveSharedKey is symmetric across two key pairs', async () => {
    const kpA = await C.generateKeyPair();
    const kpB = await C.generateKeyPair();

    const pubA = await C.exportPublicKey(kpA.publicKey);
    const pubB = await C.exportPublicKey(kpB.publicKey);

    const importedPubA = await C.importPublicKey(pubA);
    const importedPubB = await C.importPublicKey(pubB);

    // B derives using A's public key
    const keyByB = await C.deriveSharedKey(kpB.privateKey, importedPubA);
    // A derives using B's public key
    const keyByA = await C.deriveSharedKey(kpA.privateKey, importedPubB);

    // Both keys should decrypt the same ciphertext
    const plaintext = new TextEncoder().encode('symmetry check').buffer;
    const encryptedByA = await C.encrypt(plaintext, keyByA);
    const decryptedByB = await C.decrypt(encryptedByA, keyByB);
    assert.deepEqual(new Uint8Array(decryptedByB), new Uint8Array(plaintext));
});

// ---- encryptWithMetadata / decryptWithMetadata ----

test('encryptWithMetadata/decryptWithMetadata round-trip', async () => {
    const kpA = await C.generateKeyPair();
    const kpB = await C.generateKeyPair();
    const pubA = await C.exportPublicKey(kpA.publicKey);
    const keyB = await C.deriveSharedKey(kpB.privateKey, await C.importPublicKey(pubA));
    const pubB = await C.exportPublicKey(kpB.publicKey);
    const keyA = await C.deriveSharedKey(kpA.privateKey, await C.importPublicKey(pubB));

    const data = new TextEncoder().encode('image data here').buffer;
    const metadata = { name: 'test.jpg', mimeType: 'image/jpeg', originalSize: data.byteLength };

    const encrypted = await C.encryptWithMetadata(data, metadata, keyA);
    const { metadata: meta2, data: data2 } = await C.decryptWithMetadata(encrypted, keyB);

    assert.equal(meta2.name, 'test.jpg');
    assert.equal(meta2.mimeType, 'image/jpeg');
    assert.deepEqual(new Uint8Array(data2), new Uint8Array(data));
});

// ---- getKeyFingerprint ----
//
// Fingerprint length is fixed at 16 hex chars (64 bits), matching the
// recognised floor for verbal-comparison fingerprints. Any reintroduction
// of an adaptive / shorter mode would weaken MITM protection, so these
// tests pin the format.

test('getKeyFingerprint: deterministic for same key', async () => {
    const kp = await C.generateKeyPair();
    const fp1 = await C.getKeyFingerprint(kp.publicKey);
    const fp2 = await C.getKeyFingerprint(kp.publicKey);
    assert.equal(fp1, fp2);
});

test('getKeyFingerprint: fixed at 16 hex chars (64 bits, MITM floor)', async () => {
    const kp = await C.generateKeyPair();
    const fp = await C.getKeyFingerprint(kp.publicKey);
    const hexOnly = fp.replace(/-/g, '');
    assert.equal(hexOnly.length, 16);
    // Grouped as XXXX-XXXX-XXXX-XXXX
    assert.match(fp, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
});

test('getKeyFingerprint: ignores extra args (no adaptive shortening)', async () => {
    const kp = await C.generateKeyPair();
    // Older call sites passed a length; the new API takes only the key. A
    // stray second arg must NOT shorten the output, otherwise an attacker
    // (or a regressed caller) could weaken the verification code.
    const fp = await C.getKeyFingerprint(kp.publicKey, 3);
    assert.equal(fp.replace(/-/g, '').length, 16);
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
    const kpA = await crypto_.generateKeyPair();
    const kpB = await crypto_.generateKeyPair();
    const pubA = await crypto_.importPublicKey(await crypto_.exportPublicKey(kpA.publicKey));
    const pubB = await crypto_.importPublicKey(await crypto_.exportPublicKey(kpB.publicKey));
    const keysA = await crypto_.deriveSessionKeys(kpA.privateKey, pubB);
    const keysB = await crypto_.deriveSessionKeys(kpB.privateKey, pubA);
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

test('deriveSessionKeys: sharedKey matches deriveSharedKey and is symmetric', async () => {
    const kpA = await C.generateKeyPair();
    const kpB = await C.generateKeyPair();
    const pubA = await C.importPublicKey(await C.exportPublicKey(kpA.publicKey));
    const keysB = await C.deriveSessionKeys(kpB.privateKey, pubA);
    const pubB = await C.importPublicKey(await C.exportPublicKey(kpB.publicKey));
    const legacyA = await C.deriveSharedKey(kpA.privateKey, pubB);

    const plaintext = new TextEncoder().encode('session key parity').buffer;
    const encrypted = await C.encrypt(plaintext, keysB.sharedKey);
    const decrypted = await C.decrypt(encrypted, legacyA);
    assert.deepEqual(new Uint8Array(decrypted), new Uint8Array(plaintext));
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
