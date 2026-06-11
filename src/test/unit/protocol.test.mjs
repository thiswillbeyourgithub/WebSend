import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/protocol.js');
const win = await loadBrowserModule(modulePath);
const { validate, build, VERSION, MAX_FILE_SIZE,
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

test('Protocol exposes MAX_TOTAL_SESSION_BYTES, MAX_TRANSFORMS_PER_MSG', () => {
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

// ---- v2 chunked-file messages (file-start v2, segment-nack/rewind, seq resume) ----

const { SEG_SIZE, MAX_SEG_COUNT } = win.Protocol;
const VALID_SALT = 'A'.repeat(22) + '=='; // base64 of 16 bytes

test('Protocol exposes SEG_SIZE and a MAX_SEG_COUNT derived from MAX_FILE_SIZE', () => {
    assert.equal(SEG_SIZE, 256 * 1024);
    assert.equal(MAX_SEG_COUNT, MAX_FILE_SIZE / SEG_SIZE);
});

test('validate: file-start v2 with segSize/segCount/salt is ok', () => {
    assert.equal(validate({
        type: 'file-start', v: 2, segSize: SEG_SIZE, segCount: 12, salt: VALID_SALT,
    }).ok, true);
});

test('validate: file-start v2 must NOT carry a plaintext size requirement (size ignored)', () => {
    // The exact size lives inside the encrypted metadata; segCount alone
    // bounds allocation. An extra size field is tolerated (forward-compat)
    // but never required.
    assert.equal(validate({
        type: 'file-start', v: 2, segSize: SEG_SIZE, segCount: 1, salt: VALID_SALT,
    }).ok, true);
});

test('validate: file-start v2 rejects wrong segSize', () => {
    assert.equal(validate({
        type: 'file-start', v: 2, segSize: SEG_SIZE * 2, segCount: 12, salt: VALID_SALT,
    }).ok, false);
});

test('validate: file-start v2 rejects hostile segCount bounds', () => {
    for (const segCount of [0, -1, MAX_SEG_COUNT + 1, 1.5, '12']) {
        assert.equal(validate({
            type: 'file-start', v: 2, segSize: SEG_SIZE, segCount, salt: VALID_SALT,
        }).ok, false, `segCount ${segCount} must be rejected`);
    }
});

test('validate: file-start v2 rejects malformed salts', () => {
    for (const salt of ['', 'A'.repeat(24), 'A'.repeat(21) + '===', VALID_SALT + 'A', 42]) {
        assert.equal(validate({
            type: 'file-start', v: 2, segSize: SEG_SIZE, segCount: 3, salt,
        }).ok, false, `salt ${JSON.stringify(salt)} must be rejected`);
    }
});

test('validate: non-v2 file-start shapes pass validation (graceful unsupported-version nack)', () => {
    // Legacy (v undefined) and future-version file-starts intentionally
    // pass shape validation so they reach the receive flow, which answers
    // with file-nack('unsupported-version') instead of silently dropping
    // the message and stalling the sender.
    assert.equal(validate({ type: 'file-start', size: 262144 }).ok, true,
        'v1 shape forwarded for the unsupported-version nack');
    assert.equal(validate({ type: 'file-start', v: 3, blocks: 9 }).ok, true,
        'unknown future version forwarded for the unsupported-version nack');
    assert.equal(validate({ type: 'file-start', v: -1 }).ok, false);
    assert.equal(validate({ type: 'file-start', v: 'x' }).ok, false);
});

test('validate: v1-shaped resume messages are rejected', () => {
    assert.equal(validate({ type: 'file-resume-offer', size: 262144, received: 0 }).ok, false,
        'v1 offer carried size/received, v2 requires nextSeq');
    assert.equal(validate({ type: 'file-resume-ack', offset: 2048 }).ok, false,
        'v1 ack carried a byte offset, v2 requires nextSeq');
});

test('validate: segment-nack seq bounds', () => {
    assert.equal(validate({ type: 'segment-nack', seq: 0 }).ok, true);
    assert.equal(validate({ type: 'segment-nack', seq: MAX_SEG_COUNT }).ok, true);
    for (const seq of [-1, MAX_SEG_COUNT + 1, 1.5, '3', undefined]) {
        assert.equal(validate({ type: 'segment-nack', seq }).ok, false,
            `seq ${seq} must be rejected`);
    }
});

test('validate: segment-rewind requires both seq and a fresh salt', () => {
    assert.equal(validate({ type: 'segment-rewind', seq: 5, salt: VALID_SALT }).ok, true);
    assert.equal(validate({ type: 'segment-rewind', seq: 5 }).ok, false,
        'a rewind without a re-key salt would tempt nonce reuse');
    assert.equal(validate({ type: 'segment-rewind', salt: VALID_SALT }).ok, false);
    assert.equal(validate({ type: 'segment-rewind', seq: 5, salt: 'short' }).ok, false);
});

test('validate: file-resume-offer v2 {nextSeq} is ok, hostile bounds rejected', () => {
    assert.equal(validate({ type: 'file-resume-offer', nextSeq: 1 }).ok, true);
    assert.equal(validate({ type: 'file-resume-offer', nextSeq: MAX_SEG_COUNT + 1 }).ok, true,
        'nextSeq may be segCount+1 (all records received, missing only file-end)');
    for (const nextSeq of [-1, MAX_SEG_COUNT + 2, 0.5, 'x']) {
        assert.equal(validate({ type: 'file-resume-offer', nextSeq }).ok, false,
            `nextSeq ${nextSeq} must be rejected`);
    }
});

test('validate: file-resume-ack v2 requires a salt only when resuming', () => {
    assert.equal(validate({ type: 'file-resume-ack', nextSeq: 0 }).ok, true,
        'nextSeq 0 = cannot resume, no re-key needed');
    assert.equal(validate({ type: 'file-resume-ack', nextSeq: 4, salt: VALID_SALT }).ok, true);
    assert.equal(validate({ type: 'file-resume-ack', nextSeq: 4 }).ok, false,
        'resuming without a fresh salt would tempt nonce reuse');
    assert.equal(validate({ type: 'file-resume-ack', nextSeq: 4, salt: 'bad' }).ok, false);
});

test('build.fileStartV2 produces a valid stamped v2 message', () => {
    const m = build.fileStartV2(7, VALID_SALT);
    assert.equal(m.type, 'file-start');
    assert.equal(m.v, 2);
    assert.equal(m.segSize, SEG_SIZE);
    assert.equal(m.segCount, 7);
    assert.equal(m.salt, VALID_SALT);
    assert.equal(m.protocolVersion, 1);
    assert.equal(validate(m).ok, true);
});

test('build.segmentNack / build.segmentRewind produce valid messages', () => {
    assert.equal(validate(build.segmentNack(3)).ok, true);
    assert.equal(validate(build.segmentRewind(3, VALID_SALT)).ok, true);
});

test('build.fileResumeOfferV2 / build.fileResumeAckV2 produce valid messages', () => {
    assert.equal(validate(build.fileResumeOfferV2(9)).ok, true);
    assert.equal(validate(build.fileResumeAckV2(9, VALID_SALT)).ok, true);
    assert.equal(validate(build.fileResumeAckV2(0)).ok, true,
        'cannot-resume ack needs no salt');
});
