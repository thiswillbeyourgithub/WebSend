/**
 * Unit tests for segment-stream.js: the v2 chunked-AEAD sender/receiver
 * pair, exercised over an in-memory pipe with real WebCrypto keys.
 * Generated with the help of Claude Code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const js = p => path.resolve(__dirname, '../../public/js', p);

globalThis.btoa = globalThis.btoa ?? (b => Buffer.from(b, 'binary').toString('base64'));
globalThis.atob = globalThis.atob ?? (b => Buffer.from(b, 'base64').toString('binary'));

const browserGlobals = {
    TextEncoder,
    TextDecoder,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    Blob,
    Response,
    CompressionStream,
    DecompressionStream,
};

const cryptoWin = await loadBrowserModule(js('crypto.js'), browserGlobals);
const protoWin = await loadBrowserModule(js('protocol.js'));
const C = cryptoWin.WebSendCrypto;
const Protocol = protoWin.Protocol;
const win = await loadBrowserModule(js('segment-stream.js'), {
    ...browserGlobals,
    WebSendCrypto: C,
    Protocol,
});
const SS = win.SegmentStream;

const SEG = Protocol.SEG_SIZE;
const HDR = SS.RECORD_HEADER_BYTES;

/** Real ECDH/HKDF session key handles for a sender/receiver pair. */
async function makePeers() {
    const A = await C.generateKeyPair();
    const B = await C.generateKeyPair();
    const pubA = await C.importPublicKey(await C.exportPublicKey(A.publicKey));
    const pubB = await C.importPublicKey(await C.exportPublicKey(B.publicKey));
    return {
        senderKeys: await C.deriveSessionKeys(A.privateKey, pubB),
        receiverKeys: await C.deriveSessionKeys(B.privateKey, pubA),
    };
}

function patternedBytes(size) {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = i % 251;
    return buf;
}

function parseRecord(bytes) {
    const view = new DataView(bytes);
    const seq = view.getUint32(0, false);
    const ctLen = view.getUint32(4, false);
    assert.equal(bytes.byteLength, HDR + ctLen, 'record length must match its header');
    return { seq, ct: bytes.slice(HDR) };
}

const METADATA = { name: 'test.bin', mimeType: 'application/octet-stream', originalSize: 0 };

async function makePair(content, metadata = METADATA) {
    const { senderKeys, receiverKeys } = await makePeers();
    const blob = new Blob([content]);
    const sender = await SS.createSender({
        blob,
        metadata: { ...metadata, originalSize: blob.size },
        sessionKeys: senderKeys,
    });
    const receiver = SS.createReceiver({
        sessionKeys: receiverKeys,
        saltB64: sender.saltB64,
        segCount: sender.segCount,
    });
    return { sender, receiver, blob };
}

/** Pump every record from sender to receiver, asserting each verifies. */
async function pumpAll(sender, receiver) {
    let record;
    let last = null;
    while ((record = await sender.next()) !== null) {
        const { seq, ct } = parseRecord(record.bytes);
        assert.equal(seq, record.seq);
        last = await receiver.accept(seq, ct);
        assert.equal(last.ok, true, `record ${seq} must verify`);
    }
    return last;
}

test('multi-segment round-trip: content, metadata, and composite hash all match', async () => {
    const content = patternedBytes(600 * 1024); // 3 segments, final partial
    const { sender, receiver } = await makePair(content);
    assert.equal(sender.segCount, 3);

    const last = await pumpAll(sender, receiver);
    assert.equal(last.isLast, true, 'final record must report isLast');

    const { metadata, blob, compositeHashHex } = await receiver.finish();
    assert.equal(metadata.name, 'test.bin');
    assert.equal(metadata.originalSize, content.length);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), content);
    assert.equal(compositeHashHex, await sender.finishHash(),
        'sender and receiver must agree on the file identity hash');
});

test('empty file round-trips as one empty data segment', async () => {
    const { sender, receiver } = await makePair(new Uint8Array(0));
    assert.equal(sender.segCount, 1);
    const last = await pumpAll(sender, receiver);
    assert.equal(last.isLast, true);
    const { blob } = await receiver.finish();
    assert.equal(blob.size, 0);
});

test('exact segment boundary: full final segment, no off-by-one', async () => {
    const content = patternedBytes(2 * SEG);
    const { sender, receiver } = await makePair(content);
    assert.equal(sender.segCount, 2, 'an exact multiple must not create an empty tail segment');
    await pumpAll(sender, receiver);
    const { blob } = await receiver.finish();
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), content);
});

test('metadata record has a fixed size; small final segment pads to a bucket', async () => {
    // crypto.getRandomValues data is incompressible, so gzip stays off and
    // the record sizes are exactly the padded plaintext + GCM tag.
    const content = C.getRandomBytes(1000);
    const { sender } = await makePair(content);

    const meta = await sender.next();
    assert.equal(meta.bytes.byteLength, HDR + SS.META_RECORD_PLAINTEXT + 16,
        'metadata record must not leak the filename length');

    const data = await sender.next();
    assert.equal(data.bytes.byteLength, HDR + SS.FINAL_PAD_BUCKETS[0] + 16,
        '1000 bytes must pad to the 16 KiB bucket');
});

test('composite hash is gzip-independent (compressible content)', async () => {
    // Highly compressible: gzip kicks in on the wire, but the hash is over
    // the plaintext windows, so it must match a manual computation.
    const content = new Uint8Array(600 * 1024).fill(97);
    const { sender, receiver } = await makePair(content);

    let wireBytes = 0;
    let record;
    while ((record = await sender.next()) !== null) {
        wireBytes += record.bytes.byteLength;
        const { seq, ct } = parseRecord(record.bytes);
        assert.equal((await receiver.accept(seq, ct)).ok, true);
    }
    assert.ok(wireBytes < content.length / 2, 'compressible content must shrink on the wire');

    const manual = await C.finalizeCompositeHash([
        await C.sha256Bytes(content.slice(0, SEG)),
        await C.sha256Bytes(content.slice(SEG, 2 * SEG)),
        await C.sha256Bytes(content.slice(2 * SEG)),
    ]);
    assert.equal(await sender.finishHash(), manual);
    assert.equal((await receiver.finish()).compositeHashHex, manual);
});

test('rewind re-keys: same seq yields different bytes, receiver recovers via rekey', async () => {
    const content = patternedBytes(600 * 1024);
    const { sender, receiver } = await makePair(content);

    // Deliver metadata + first data segment.
    for (let i = 0; i < 2; i++) {
        const { seq, ct } = parseRecord((await sender.next()).bytes);
        assert.equal((await receiver.accept(seq, ct)).ok, true);
    }
    // Produce segment 2, but pretend it was lost/corrupted in transit.
    const firstTry = (await sender.next()).bytes;

    const { saltB64: newSalt } = await sender.rewind(2);
    assert.equal(sender.nextSeq, 2);
    const secondTry = (await sender.next()).bytes;
    assert.notDeepEqual(new Uint8Array(secondTry), new Uint8Array(firstTry),
        'a rewound segment must be sealed under a fresh key, never byte-identical');

    // Receiver without the rekey must reject the re-sent record...
    assert.equal((await receiver.accept(2, parseRecord(secondTry).ct)).reason, 'auth');
    // ...and accept it after applying the new salt.
    receiver.rekey(newSalt, 2);
    assert.equal((await receiver.accept(2, parseRecord(secondTry).ct)).ok, true);

    const { seq, ct } = parseRecord((await sender.next()).bytes);
    assert.equal((await receiver.accept(seq, ct)).ok, true);
    const { blob, compositeHashHex } = await receiver.finish();
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), content);
    assert.equal(compositeHashHex, await sender.finishHash(),
        'a rewind must not change the file identity hash');
});

test('rekey to an earlier seq discards the now-stale tail segments', async () => {
    const content = patternedBytes(600 * 1024);
    const { sender, receiver } = await makePair(content);
    await pumpAll(sender, receiver);
    assert.equal(receiver.nextSeq, 4);

    // A reconnect resume that restarts from segment 1 invalidates everything.
    const { saltB64 } = await sender.rewind(1);
    receiver.rekey(saltB64, 1);
    assert.equal(receiver.nextSeq, 1);
    assert.equal(receiver.verifiedBytes, 0, 'segments at/past the rewind point must be dropped');

    await pumpAll(sender, receiver);
    const { blob } = await receiver.finish();
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), content);
});

test('receiver rejects tampering, reordering, and skipped records with reasons', async () => {
    const content = patternedBytes(SEG + 100);
    const { sender, receiver } = await makePair(content);

    const meta = parseRecord((await sender.next()).bytes);
    const seg1 = parseRecord((await sender.next()).bytes);

    assert.equal((await receiver.accept(seg1.seq, seg1.ct)).reason, 'out-of-order',
        'record 1 before record 0 must be refused without touching the key');

    const tampered = new Uint8Array(meta.ct.slice(0));
    tampered[10] ^= 0x01;
    assert.equal((await receiver.accept(0, tampered.buffer)).reason, 'auth');

    // The honest records still go through afterwards.
    assert.equal((await receiver.accept(meta.seq, meta.ct)).ok, true);
    assert.equal((await receiver.accept(seg1.seq, seg1.ct)).ok, true);
});

test('finish() and finishHash() refuse incomplete transfers', async () => {
    const content = patternedBytes(SEG + 100);
    const { sender, receiver } = await makePair(content);
    const { seq, ct } = parseRecord((await sender.next()).bytes);
    await receiver.accept(seq, ct);
    await assert.rejects(() => receiver.finish(), /verified/);
    await assert.rejects(() => sender.finishHash(), /before all segments/);
});

test('createSender rejects files beyond the segment cap', async () => {
    const { senderKeys } = await makePeers();
    // Only .size is read before the cap check, so a stub Blob suffices and
    // no multi-GiB allocation is needed.
    const hugeBlob = { size: (Protocol.MAX_SEG_COUNT + 1) * SEG };
    await assert.rejects(
        () => SS.createSender({ blob: hugeBlob, metadata: METADATA, sessionKeys: senderKeys }),
        /too large/i);
});

test('createSender rejects oversized metadata before sending anything', async () => {
    const { sender } = await makePair(patternedBytes(100), {
        ...METADATA,
        name: 'x'.repeat(SS.META_RECORD_PLAINTEXT),
    });
    await assert.rejects(() => sender.next(), /metadata too large/i);
});

test('estimateWireOffset matches cumulative wire bytes for incompressible content', async () => {
    const content = C.getRandomBytes(2 * SEG + 1000);
    const { sender } = await makePair(content);
    let cumulative = 0;
    let record;
    while ((record = await sender.next()) !== null) {
        assert.equal(cumulative, sender.estimateWireOffset(record.seq),
            `offset estimate for record ${record.seq} must match bytes sent so far`);
        cumulative += record.bytes.byteLength;
    }
    assert.equal(cumulative, sender.estimateWireOffset(sender.segCount + 1),
        'past-the-end offset must equal the full wire size');
    assert.throws(() => sender.estimateWireOffset(sender.segCount + 2), /Invalid/);
});

test('rewind to segCount+1 is legal (resume that only re-sends file-end)', async () => {
    const { sender } = await makePair(patternedBytes(SEG + 100));
    while (await sender.next() !== null) { /* drain */ }
    await sender.rewind(sender.segCount + 1);
    assert.equal(await sender.next(), null, 'nothing is left to resend');
    await assert.rejects(() => sender.rewind(sender.segCount + 2), /Invalid rewind/);
});

/** In-memory transport io for pump(): collects control frames and the
 * concatenated chunk bytes, with a per-chunk hook for fault injection. */
function makePumpIo({ chunkSize = 1000, onChunk = () => {} } = {}) {
    const controls = [];
    const chunks = [];
    return {
        controls,
        chunks,
        get wireBytes() {
            const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
            const merged = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { merged.set(new Uint8Array(c), off); off += c.byteLength; }
            return merged;
        },
        chunkSize,
        sendControl: (m) => { controls.push(m); return true; },
        backlogBytes: () => 0,
        sendChunk: async (chunk) => {
            onChunk(chunks.length);
            chunks.push(chunk);
        },
    };
}

/** Split a concatenated record stream and accept everything into {receiver}. */
async function acceptWire(receiver, wire) {
    let off = 0;
    while (off < wire.length) {
        const view = new DataView(wire.buffer, off);
        const seq = view.getUint32(0, false);
        const ctLen = view.getUint32(4, false);
        const ct = wire.slice(off + HDR, off + HDR + ctLen).buffer;
        off += HDR + ctLen;
        assert.equal((await receiver.accept(seq, ct)).ok, true, `record ${seq} must verify`);
    }
}

test('pump drives a fresh transfer end-to-end through a chunking transport', async () => {
    const content = patternedBytes(600 * 1024);
    const { senderKeys, receiverKeys } = await makePeers();
    const blob = new Blob([content]);
    const sender = await SS.createSender({
        blob, metadata: { ...METADATA, originalSize: blob.size }, sessionKeys: senderKeys,
    });
    const io = makePumpIo({ chunkSize: 1000 }); // records span many chunks
    const progress = [];

    await SS.pump(sender, io, (percent, delivered, total) => progress.push({ percent, delivered, total }), undefined);

    assert.deepEqual(io.controls.map(m => m.type), ['file-start', 'file-end']);
    assert.equal(io.controls[0].v, 2);
    assert.equal(io.controls[0].salt, sender.saltB64);

    const receiver = SS.createReceiver({
        sessionKeys: receiverKeys, saltB64: io.controls[0].salt, segCount: io.controls[0].segCount,
    });
    await acceptWire(receiver, io.wireBytes);
    const { blob: out } = await receiver.finish();
    assert.deepEqual(new Uint8Array(await out.arrayBuffer()), content);

    assert.ok(progress.length >= sender.totalRecords, 'progress fires per record');
    assert.equal(progress.at(-1).percent, 100);
    assert.ok(progress.every(p => p.total === sender.estimatedWireSize));
});

test('pump resume skips file-start and the receiver heals via rekey', async () => {
    const content = patternedBytes(600 * 1024); // 3 data segments
    const { sender, receiver } = await makePair(content);

    // Records 0 and 1 made it across before the drop.
    for (let i = 0; i < 2; i++) {
        const { seq, ct } = parseRecord((await sender.next()).bytes);
        assert.equal((await receiver.accept(seq, ct)).ok, true);
    }
    // Reconnect resume: receiver offered nextSeq=2, sender rewound and
    // acked with the fresh salt, receiver rekeys (what handleResumeOffer
    // and handleFileResumeAck do around the transport call).
    const { saltB64 } = await sender.rewind(2);
    receiver.rekey(saltB64, 2);

    const io = makePumpIo();
    await SS.pump(sender, io, null, 2);

    assert.deepEqual(io.controls.map(m => m.type), ['file-end'],
        'a resume must not send a fresh file-start');
    await acceptWire(receiver, io.wireBytes);
    const { blob: out } = await receiver.finish();
    assert.deepEqual(new Uint8Array(await out.arrayBuffer()), content);
});

test('pump stamps transient transport errors with the in-flight record seq', async () => {
    const content = patternedBytes(600 * 1024);
    const { sender } = await makePair(content);

    // The metadata record (2048 + header + tag = 2072 bytes) occupies
    // chunks 0..2 at chunkSize 1000, so failing on chunk 3 drops the
    // transport while record 1 is on the wire.
    const io = makePumpIo({
        onChunk: (i) => {
            if (i === 3) throw new win.TransientDisconnectError('drop');
        },
    });

    await assert.rejects(
        () => SS.pump(sender, io, null, undefined),
        (e) => {
            assert.equal(e.transient, true);
            assert.equal(e.nextSeq, 1, 'the record in flight must be the resume point');
            return true;
        });
});

// ---- transfer(): the segment-nack → rewind → resend retry tail ----

/**
 * Transfer io whose waitForAck() pops scripted verdicts. chunkSize is
 * larger than any record so chunks map 1:1 to wire records.
 */
function makeTransferIo(verdicts) {
    const io = makePumpIo({ chunkSize: 1 << 20 });
    io.waitForAck = async () => {
        if (!verdicts.length) throw new Error('test script ran out of verdicts');
        return verdicts.shift();
    };
    return io;
}

function wireSeqs(io) {
    return io.chunks.map(c => parseRecord(c).seq);
}

test('transfer returns the ack verdict when no nack arrives', async () => {
    const { sender } = await makePair(patternedBytes(1000));
    const io = makeTransferIo([{ acknowledged: true, sha256: 'x'.repeat(64) }]);
    const verdict = await SS.transfer(sender, io, null, undefined);
    assert.equal(verdict.acknowledged, true);
    assert.deepEqual(io.controls.map(m => m.type), ['file-start', 'file-end']);
});

test('transfer heals a segment-nack: rewind control, fresh salt, tail resent, receiver completes', async () => {
    const content = patternedBytes(600 * 1024); // 3 data segments
    const { sender, receiver } = await makePair(content);
    const originalSalt = sender.saltB64;
    const io = makeTransferIo([
        { segmentNack: 2 },
        { acknowledged: true, sha256: 'x'.repeat(64) },
    ]);

    const verdict = await SS.transfer(sender, io, null, undefined);
    assert.equal(verdict.acknowledged, true);

    assert.deepEqual(io.controls.map(m => m.type),
        ['file-start', 'file-end', 'segment-rewind', 'file-end'],
        'no second file-start: the receiver keeps its verified prefix');
    const rewind = io.controls[2];
    assert.equal(rewind.seq, 2);
    assert.notEqual(rewind.salt, originalSalt, 'a rewind must re-key');
    assert.deepEqual(wireSeqs(io), [0, 1, 2, 3, 2, 3], 'only the tail is resent');

    // Receiver's view: first-pass records up to the nack verify under the
    // original salt, the resent tail under the rewind salt.
    for (const i of [0, 1]) {
        const { seq, ct } = parseRecord(io.chunks[i]);
        assert.equal((await receiver.accept(seq, ct)).ok, true);
    }
    receiver.rekey(rewind.salt, 2);
    for (const i of [4, 5]) {
        const { seq, ct } = parseRecord(io.chunks[i]);
        assert.equal((await receiver.accept(seq, ct)).ok, true, `resent record must verify under the fresh salt`);
    }
    const { blob: out } = await receiver.finish();
    assert.deepEqual(new Uint8Array(await out.arrayBuffer()), content);
});

test('transfer rewinds to record 0 without resending file-start', async () => {
    const content = patternedBytes(1000);
    const { sender, receiver } = await makePair(content);
    const io = makeTransferIo([
        { segmentNack: 0 },
        { acknowledged: true, sha256: 'x'.repeat(64) },
    ]);
    await SS.transfer(sender, io, null, undefined);
    assert.deepEqual(io.controls.map(m => m.type),
        ['file-start', 'file-end', 'segment-rewind', 'file-end']);
    assert.deepEqual(wireSeqs(io), [0, 1, 0, 1]);

    // Even the metadata record is replayable under the fresh salt.
    receiver.rekey(io.controls[2].salt, 0);
    for (const i of [2, 3]) {
        const { seq, ct } = parseRecord(io.chunks[i]);
        assert.equal((await receiver.accept(seq, ct)).ok, true);
    }
    const { metadata } = await receiver.finish();
    assert.equal(metadata.name, 'test.bin');
});

test('transfer gives up after MAX_SEGMENT_RETRIES nacks with a non-transient error', async () => {
    const { sender } = await makePair(patternedBytes(1000));
    const nacks = Array.from({ length: SS.MAX_SEGMENT_RETRIES + 1 }, () => ({ segmentNack: 1 }));
    const io = makeTransferIo(nacks);
    await assert.rejects(
        () => SS.transfer(sender, io, null, undefined),
        (e) => {
            assert.match(e.message, /rewinds/);
            assert.notEqual(e.transient, true, 'budget exhaustion is fatal, not resumable');
            return true;
        });
    assert.equal(io.controls.filter(m => m.type === 'segment-rewind').length,
        SS.MAX_SEGMENT_RETRIES);
});

test('transfer rejects a hostile nack outside the record range', async () => {
    const { sender } = await makePair(patternedBytes(1000));
    const io = makeTransferIo([{ segmentNack: sender.segCount + 2 }]);
    await assert.rejects(
        () => SS.transfer(sender, io, null, undefined),
        /outside the file's record range/);
    assert.equal(io.controls.filter(m => m.type === 'segment-rewind').length, 0,
        'no rewind may be sent for an unsatisfiable nack');
});

test('estimatedWireSize is an upper bound and exact for incompressible content', async () => {
    const content = C.getRandomBytes(SEG + 1000);
    const { sender } = await makePair(content);
    let actual = 0;
    let record;
    while ((record = await sender.next()) !== null) actual += record.bytes.byteLength;
    assert.equal(actual, sender.estimatedWireSize,
        'incompressible content must hit the estimate exactly');

    const { sender: gzSender } = await makePair(new Uint8Array(SEG + 1000).fill(97));
    let gzActual = 0;
    while ((record = await gzSender.next()) !== null) gzActual += record.bytes.byteLength;
    assert.ok(gzActual <= gzSender.estimatedWireSize,
        'compression may only shrink the wire size below the estimate');
});
