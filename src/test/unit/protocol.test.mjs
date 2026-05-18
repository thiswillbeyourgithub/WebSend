import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/protocol.js');
const win = await loadBrowserModule(modulePath);
const { validate, build, VERSION, MIN_FILE_START_SIZE, MAX_FILE_SIZE,
        MAX_TOTAL_SESSION_BYTES, MAX_TRANSFORMS_PER_MSG,
        MAX_CONTROL_MSG_BYTES } = win.Protocol;

const VALID_HASH = 'a'.repeat(64);
const VALID_CROP_CORNERS = {
    tl: { x: 0, y: 0 },
    tr: { x: 1, y: 0 },
    br: { x: 1, y: 1 },
    bl: { x: 0, y: 1 },
};

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

test('validate: file-start with number size at the bucket floor is ok', () => {
    assert.equal(validate({ type: 'file-start', size: MIN_FILE_START_SIZE }).ok, true);
});

test('validate: file-start with size below MIN_FILE_START_SIZE is rejected', () => {
    assert.equal(validate({ type: 'file-start', size: MIN_FILE_START_SIZE - 1 }).ok, false);
    assert.equal(validate({ type: 'file-start', size: 1024 }).ok, false);
    assert.equal(validate({ type: 'file-start', size: 0 }).ok, false);
    assert.equal(validate({ type: 'file-start', size: -1 }).ok, false);
});

test('validate: file-start with size above MAX_FILE_SIZE is rejected', () => {
    assert.equal(validate({ type: 'file-start', size: MAX_FILE_SIZE + 1 }).ok, false);
    assert.equal(validate({ type: 'file-start', size: Number.MAX_SAFE_INTEGER }).ok, false);
});

test('Protocol exposes MIN_FILE_START_SIZE, MAX_TOTAL_SESSION_BYTES, MAX_TRANSFORMS_PER_MSG', () => {
    assert.equal(typeof MIN_FILE_START_SIZE, 'number');
    assert.ok(MIN_FILE_START_SIZE >= 16 * 1024);
    assert.equal(typeof MAX_TOTAL_SESSION_BYTES, 'number');
    assert.ok(MAX_TOTAL_SESSION_BYTES >= MAX_FILE_SIZE);
    assert.equal(typeof MAX_TRANSFORMS_PER_MSG, 'number');
    assert.ok(MAX_TRANSFORMS_PER_MSG >= 1 && MAX_TRANSFORMS_PER_MSG <= 1024);
});

test('Protocol exposes MAX_CONTROL_MSG_BYTES as a bounded value', () => {
    // Cap exists so a hostile peer cannot force a multi-MB JSON.parse
    // allocation on the receiver. 16 KiB is comfortable headroom for the
    // largest legitimate control message (sender-public-key ~200 bytes).
    assert.equal(typeof MAX_CONTROL_MSG_BYTES, 'number');
    assert.ok(MAX_CONTROL_MSG_BYTES >= 4 * 1024);
    assert.ok(MAX_CONTROL_MSG_BYTES <= 1024 * 1024);
});

// ---- transform-image bounds (Finding 2 / iteration 1) ----

test('validate: transform-image with crop and valid corners is ok', () => {
    const r = validate({
        type: 'transform-image', oldHash: VALID_HASH,
        transforms: [{ op: 'crop', corners: VALID_CROP_CORNERS }],
    });
    assert.equal(r.ok, true);
});

test('validate: transform-image rejects crop without corners', () => {
    const r = validate({
        type: 'transform-image', oldHash: VALID_HASH,
        transforms: [{ op: 'crop' }],
    });
    assert.equal(r.ok, false);
});

test('validate: transform-image rejects crop with corners outside [0,1]', () => {
    const corners = { ...VALID_CROP_CORNERS, br: { x: 50000, y: 50000 } };
    const r = validate({
        type: 'transform-image', oldHash: VALID_HASH,
        transforms: [{ op: 'crop', corners }],
    });
    assert.equal(r.ok, false);
});

test('validate: transform-image rejects crop with negative corner', () => {
    const corners = { ...VALID_CROP_CORNERS, tl: { x: -0.1, y: 0 } };
    const r = validate({
        type: 'transform-image', oldHash: VALID_HASH,
        transforms: [{ op: 'crop', corners }],
    });
    assert.equal(r.ok, false);
});

test('validate: transform-image rejects crop with NaN corner', () => {
    const corners = { ...VALID_CROP_CORNERS, tr: { x: NaN, y: 0 } };
    const r = validate({
        type: 'transform-image', oldHash: VALID_HASH,
        transforms: [{ op: 'crop', corners }],
    });
    assert.equal(r.ok, false);
});

test('validate: transform-image rejects crop missing one corner key', () => {
    const corners = { tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, br: { x: 1, y: 1 } };
    const r = validate({
        type: 'transform-image', oldHash: VALID_HASH,
        transforms: [{ op: 'crop', corners }],
    });
    assert.equal(r.ok, false);
});

test('validate: transform-image accepts MAX_TRANSFORMS_PER_MSG entries', () => {
    const transforms = Array.from({ length: MAX_TRANSFORMS_PER_MSG }, () => ({ op: 'rotateCW' }));
    const r = validate({ type: 'transform-image', oldHash: VALID_HASH, transforms });
    assert.equal(r.ok, true);
});

test('validate: transform-image rejects MAX_TRANSFORMS_PER_MSG + 1 entries', () => {
    const transforms = Array.from({ length: MAX_TRANSFORMS_PER_MSG + 1 }, () => ({ op: 'rotateCW' }));
    const r = validate({ type: 'transform-image', oldHash: VALID_HASH, transforms });
    assert.equal(r.ok, false);
});

test('validate: transform-image rejects huge transforms array (10^6 ops)', () => {
    const transforms = new Array(1000000).fill({ op: 'rotateCW' });
    const r = validate({ type: 'transform-image', oldHash: VALID_HASH, transforms });
    assert.equal(r.ok, false);
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
    const m = build.fileStart(MIN_FILE_START_SIZE);
    assert.equal(m.size, MIN_FILE_START_SIZE);
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

// ---- file-resume-offer / file-resume-ack (relay-reconnect resume protocol) ----

test('validate: file-resume-offer with valid size+received is ok', () => {
    const r = validate({
        type: 'file-resume-offer',
        size: MIN_FILE_START_SIZE,
        received: 0,
    });
    assert.equal(r.ok, true);
});

test('validate: file-resume-offer with received < size is ok', () => {
    const r = validate({
        type: 'file-resume-offer',
        size: MIN_FILE_START_SIZE * 4,
        received: MIN_FILE_START_SIZE * 2,
    });
    assert.equal(r.ok, true);
});

test('validate: file-resume-offer rejects size below MIN_FILE_START_SIZE', () => {
    assert.equal(validate({ type: 'file-resume-offer', size: 1024, received: 0 }).ok, false);
});

test('validate: file-resume-offer rejects size above MAX_FILE_SIZE', () => {
    assert.equal(validate({ type: 'file-resume-offer', size: MAX_FILE_SIZE + 1, received: 0 }).ok, false);
});

test('validate: file-resume-offer rejects negative received', () => {
    assert.equal(validate({ type: 'file-resume-offer', size: MIN_FILE_START_SIZE, received: -1 }).ok, false);
});

test('validate: file-resume-offer rejects non-integer received', () => {
    assert.equal(validate({ type: 'file-resume-offer', size: MIN_FILE_START_SIZE, received: 1.5 }).ok, false);
});

test('validate: file-resume-offer rejects missing fields', () => {
    assert.equal(validate({ type: 'file-resume-offer', size: MIN_FILE_START_SIZE }).ok, false);
    assert.equal(validate({ type: 'file-resume-offer', received: 0 }).ok, false);
});

test('validate: file-resume-ack with offset 0 is ok', () => {
    assert.equal(validate({ type: 'file-resume-ack', offset: 0 }).ok, true);
});

test('validate: file-resume-ack with positive offset is ok', () => {
    assert.equal(validate({ type: 'file-resume-ack', offset: 1024 }).ok, true);
});

test('validate: file-resume-ack rejects negative offset', () => {
    assert.equal(validate({ type: 'file-resume-ack', offset: -1 }).ok, false);
});

test('validate: file-resume-ack rejects non-integer offset', () => {
    assert.equal(validate({ type: 'file-resume-ack', offset: 1.5 }).ok, false);
});

test('validate: file-resume-ack rejects offset above MAX_FILE_SIZE', () => {
    assert.equal(validate({ type: 'file-resume-ack', offset: MAX_FILE_SIZE + 1 }).ok, false);
});

test('build.fileResumeOffer produces valid stamped message', () => {
    const m = build.fileResumeOffer(MIN_FILE_START_SIZE * 4, MIN_FILE_START_SIZE);
    assert.equal(m.type, 'file-resume-offer');
    assert.equal(m.size, MIN_FILE_START_SIZE * 4);
    assert.equal(m.received, MIN_FILE_START_SIZE);
    assert.equal(m.protocolVersion, 1);
    assert.equal(validate(m).ok, true);
});

test('build.fileResumeAck produces valid stamped message', () => {
    const m = build.fileResumeAck(2048);
    assert.equal(m.type, 'file-resume-ack');
    assert.equal(m.offset, 2048);
    assert.equal(m.protocolVersion, 1);
    assert.equal(validate(m).ok, true);
});

test('build.fileResumeAck with 0 offset (cannot-resume signal) is valid', () => {
    const m = build.fileResumeAck(0);
    assert.equal(validate(m).ok, true);
});
