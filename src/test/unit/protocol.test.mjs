import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/protocol.js');
const win = await loadBrowserModule(modulePath);
const { validate, build, VERSION } = win.Protocol;

const VALID_HASH = 'a'.repeat(64);

// ---- VERSION ----

test('Protocol.VERSION is 1', () => {
    assert.equal(VERSION, 1);
});

// ---- validate: good messages ----

test('validate: public-key with string key is ok', () => {
    assert.equal(validate({ type: 'public-key', key: 'abc' }).ok, true);
});

test('validate: sender-public-key with string key is ok', () => {
    assert.equal(validate({ type: 'sender-public-key', key: 'abc' }).ok, true);
});

test('validate: fingerprint-confirmed (no fields) is ok', () => {
    assert.equal(validate({ type: 'fingerprint-confirmed' }).ok, true);
});

test('validate: fingerprint-denied (no fields) is ok', () => {
    assert.equal(validate({ type: 'fingerprint-denied' }).ok, true);
});

test('validate: ready (no fields) is ok', () => {
    assert.equal(validate({ type: 'ready' }).ok, true);
});

test('validate: file-start with number size is ok', () => {
    assert.equal(validate({ type: 'file-start', size: 1024 }).ok, true);
});

test('validate: file-end (no fields) is ok', () => {
    assert.equal(validate({ type: 'file-end' }).ok, true);
});

test('validate: file-ack with 64-char hex sha256 is ok', () => {
    assert.equal(validate({ type: 'file-ack', sha256: VALID_HASH }).ok, true);
});

test('validate: file-nack with string error is ok', () => {
    assert.equal(validate({ type: 'file-nack', error: 'decrypt failed' }).ok, true);
});

test('validate: delete-image with hex64 hash is ok', () => {
    assert.equal(validate({ type: 'delete-image', hash: VALID_HASH }).ok, true);
});

test('validate: transform-image with valid transforms array is ok', () => {
    assert.equal(validate({
        type: 'transform-image', oldHash: VALID_HASH,
        transforms: [{ op: 'rotateCW' }, { op: 'bw' }],
    }).ok, true);
});

test('validate: transform-nack with reason is ok', () => {
    assert.equal(validate({ type: 'transform-nack', oldHash: VALID_HASH, reason: 'not found' }).ok, true);
});

test('validate: replace-image with hex64 hash is ok', () => {
    assert.equal(validate({ type: 'replace-image', oldHash: VALID_HASH }).ok, true);
});

test('validate: batch-start is ok', () => {
    assert.equal(validate({ type: 'batch-start' }).ok, true);
});

test('validate: batch-start-if-nonempty is ok', () => {
    assert.equal(validate({ type: 'batch-start-if-nonempty' }).ok, true);
});

test('validate: batch-end is ok', () => {
    assert.equal(validate({ type: 'batch-end' }).ok, true);
});

test('validate: extra unknown fields are tolerated (forward-compat)', () => {
    assert.equal(validate({ type: 'ready', futureField: 42 }).ok, true);
});

// ---- validate: bad messages ----

test('validate: null returns error', () => {
    const r = validate(null);
    assert.equal(r.ok, false);
    assert.ok(r.error);
});

test('validate: missing type returns error', () => {
    const r = validate({ key: 'x' });
    assert.equal(r.ok, false);
});

test('validate: unknown type returns error', () => {
    const r = validate({ type: 'nonexistent' });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('unknown message type'));
});

test('validate: public-key without key returns error', () => {
    const r = validate({ type: 'public-key' });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("'key'"));
});

test('validate: public-key with non-string key returns error', () => {
    const r = validate({ type: 'public-key', key: 42 });
    assert.equal(r.ok, false);
});

test('validate: file-start with string size returns error', () => {
    const r = validate({ type: 'file-start', size: '1024' });
    assert.equal(r.ok, false);
});

test('validate: file-ack with 63-char hash returns error', () => {
    const r = validate({ type: 'file-ack', sha256: 'a'.repeat(63) });
    assert.equal(r.ok, false);
});

test('validate: file-ack with 65-char hash returns error', () => {
    const r = validate({ type: 'file-ack', sha256: 'a'.repeat(65) });
    assert.equal(r.ok, false);
});

test('validate: file-ack with non-hex chars returns error', () => {
    const r = validate({ type: 'file-ack', sha256: 'g'.repeat(64) });
    assert.equal(r.ok, false);
});

test('validate: transform-image with empty transforms array returns error', () => {
    const r = validate({ type: 'transform-image', oldHash: VALID_HASH, transforms: [] });
    assert.equal(r.ok, false);
});

test('validate: transform-image with invalid op returns error', () => {
    const r = validate({ type: 'transform-image', oldHash: VALID_HASH, transforms: [{ op: 'invalid' }] });
    assert.equal(r.ok, false);
});

// ---- builders ----

test('build.publicKey produces valid stamped message', () => {
    const m = build.publicKey('mykey');
    assert.equal(m.type, 'public-key');
    assert.equal(m.key, 'mykey');
    assert.equal(m.protocolVersion, 1);
    assert.equal(validate(m).ok, true);
});

test('build.senderPublicKey produces valid stamped message', () => {
    const m = build.senderPublicKey('k');
    assert.equal(validate(m).ok, true);
    assert.equal(m.protocolVersion, 1);
});

test('build.fingerprintConfirmed produces valid message', () => {
    const m = build.fingerprintConfirmed();
    assert.equal(validate(m).ok, true);
    assert.equal(m.protocolVersion, 1);
});

test('build.fileStart produces valid message', () => {
    const m = build.fileStart(2048);
    assert.equal(m.size, 2048);
    assert.equal(validate(m).ok, true);
});

test('build.fileAck produces valid message', () => {
    const m = build.fileAck(VALID_HASH);
    assert.equal(validate(m).ok, true);
});

test('build.fileNack produces valid message', () => {
    const m = build.fileNack('checksum mismatch');
    assert.equal(validate(m).ok, true);
});

test('build.deleteImage produces valid message', () => {
    const m = build.deleteImage(VALID_HASH);
    assert.equal(validate(m).ok, true);
});

test('build.transformImage produces valid message', () => {
    const m = build.transformImage(VALID_HASH, [{ op: 'rotateCW' }]);
    assert.equal(validate(m).ok, true);
});

test('build.transformNack produces valid message', () => {
    const m = build.transformNack(VALID_HASH, 'hash not found');
    assert.equal(validate(m).ok, true);
});

test('build.replaceImage produces valid message', () => {
    const m = build.replaceImage(VALID_HASH);
    assert.equal(validate(m).ok, true);
});

test('build.batchStart produces valid message', () => {
    assert.equal(validate(build.batchStart()).ok, true);
});

test('build.batchStartIfNonempty produces valid message', () => {
    assert.equal(validate(build.batchStartIfNonempty()).ok, true);
});

test('build.batchEnd produces valid message', () => {
    assert.equal(validate(build.batchEnd()).ok, true);
});

test('build.ready produces valid message', () => {
    assert.equal(validate(build.ready()).ok, true);
});
