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

// ---- computeFingerprintLength ----

test('computeFingerprintLength: four branches', () => {
    assert.equal(C.computeFingerprintLength(0),     3);
    assert.equal(C.computeFingerprintLength(10),    3);
    assert.equal(C.computeFingerprintLength(11),    6);
    assert.equal(C.computeFingerprintLength(100),   6);
    assert.equal(C.computeFingerprintLength(101),   9);
    assert.equal(C.computeFingerprintLength(1000),  9);
    assert.equal(C.computeFingerprintLength(1001), 12);
    assert.equal(C.computeFingerprintLength(9999), 12);
});

// ---- getKeyFingerprint ----

test('getKeyFingerprint: deterministic for same key', async () => {
    const kp = await C.generateKeyPair();
    const fp1 = await C.getKeyFingerprint(kp.publicKey, 8);
    const fp2 = await C.getKeyFingerprint(kp.publicKey, 8);
    assert.equal(fp1, fp2);
});

test('getKeyFingerprint: clamps to max 12', async () => {
    const kp = await C.generateKeyPair();
    const fp = await C.getKeyFingerprint(kp.publicKey, 99);
    // 12 hex chars grouped in chunks of 4 -> "XXXX-XXXX-XXXX"
    const hexOnly = fp.replace(/-/g, '');
    assert.equal(hexOnly.length, 12);
});

test('getKeyFingerprint: clamps to min 3', async () => {
    const kp = await C.generateKeyPair();
    const fp = await C.getKeyFingerprint(kp.publicKey, 1);
    const hexOnly = fp.replace(/-/g, '');
    assert.equal(hexOnly.length, 3);
});
