/**
 * Integration test for the v2 in-connection retry path, with REAL crypto:
 * crypto.js + protocol.js + segment-stream.js + transport-assembler.js +
 * receive-flow.js loaded into one vm realm and wired together through an
 * in-memory pipe playing the transport.
 *
 * The headline scenario is the one the whole mechanism exists for: a
 * relay flips one bit in one record mid-transfer. The receiver must
 * detect it (AEAD tag), segment-nack, the sender must rewind with a
 * fresh salt, and the transfer must complete with intact content and a
 * matching composite hash, with no human-visible failure.
 *
 * Generated with the help of Claude Code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const js = p => path.resolve(__dirname, '../../public/js', p);

globalThis.btoa = globalThis.btoa ?? (b => Buffer.from(b, 'binary').toString('base64'));
globalThis.atob = globalThis.atob ?? (b => Buffer.from(b, 'base64').toString('binary'));

const stubLogger = { info: () => {}, success: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** One vm realm with every module the two endpoints need. */
function loadRealm() {
    const win = { logger: stubLogger };
    const ctx = createContext({
        window: win,
        logger: stubLogger,
        crypto: globalThis.crypto,
        console,
        setTimeout, clearTimeout,
        TextEncoder, TextDecoder,
        btoa: globalThis.btoa, atob: globalThis.atob,
        Blob, Response, CompressionStream, DecompressionStream,
    });
    for (const f of ['crypto.js', 'protocol.js', 'segment-stream.js',
                     'transport-assembler.js', 'receive-flow.js']) {
        runInContext(readFileSync(js(f), 'utf8'), ctx);
    }
    // The modules reference each other as bare globals (browser style).
    // Property form: crypto.js declares a top-level `const WebSendCrypto`
    // in this realm, which a bare assignment would collide with.
    runInContext('globalThis.WebSendCrypto = window.WebSendCrypto; globalThis.Protocol = window.Protocol;', ctx);
    return win;
}

function patternedBytes(size) {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = i % 251;
    return buf;
}

/**
 * Build a full sender↔receiver harness around one realm:
 * - receiver: a PayloadAssembler host feeding ReceiveFlow (attached with
 *   stubbed page deps), real session keys;
 * - sender: a SegmentSender plus the transport io for
 *   SegmentStream.transfer, whose control/binary sends are delivered
 *   straight into the receiver host and whose waitForAck is the real
 *   PayloadAssembler file-ack machinery on a sender-side host;
 * - corruptChunk(i, bytes) hook for fault injection on the wire.
 */
async function makeHarness(win, content, { corrupt = () => {} } = {}) {
    const C = win.WebSendCrypto;
    const PA = win.PayloadAssembler;
    const RF = win.ReceiveFlow;

    const A = await C.generateKeyPair();
    const B = await C.generateKeyPair();
    const pubA = await C.importPublicKey(await C.exportPublicKey(A.publicKey));
    const pubB = await C.importPublicKey(await C.exportPublicKey(B.publicKey));
    const senderKeys = await C.deriveSessionKeys(A.privateKey, pubB);
    const receiverKeys = await C.deriveSessionKeys(B.privateKey, pubA);

    // ---- receiver endpoint ----
    const images = [];
    const receiverOut = [];   // control messages the receiver sends back
    const rxAborts = [];

    const senderHost = { tag: 'TX', onMessage: () => {} };
    PA.initState(senderHost);

    win.Collections = {
        getActive: () => ({ id: 1, images: [] }),
        setName: () => {},
        addReceivedFile: () => {},
    };
    win.ReceiveCard = {
        setCardImage: () => {},
        makeSafeBlobUrl: () => 'blob:test/safe',
        SAFE_BLOB_TYPE: 'application/octet-stream',
    };
    win.ReceiveExport = { preloadClientZip: () => {} };
    win.BgOcr = { queue: () => {}, cancel: () => {} };

    RF.attach({
        receivedImagesRef: images,
        // The receiver's outbound channel feeds the sender's assembler,
        // exactly like a transport would.
        getRtc: () => ({
            sendMessage: (m) => {
                receiverOut.push(m);
                win.PayloadAssembler.handleControl(senderHost, m);
                return true;
            },
        }),
        logger: stubLogger,
        i18n: { t: (k) => k },
        showToast: () => {},
        getSessionKeys: () => receiverKeys,
        getPendingReplaceHash: () => null,
        setPendingReplaceHash: () => {},
        getConnectionTimestamp: () => 1,
        incrementPhotoCount: () => {},
        finalizeReceiveStats: () => {},
        updateExportButton: () => {},
    });

    const receiverHost = {
        tag: 'RX',
        onMessage: (m) => {
            if (m.type === 'file-segment') RF.handleFileSegment(m);
        },
        _abortTransport: (reason) => rxAborts.push(reason),
    };
    PA.initState(receiverHost);

    // ---- sender endpoint ----
    const blob = new Blob([content]);
    const sender = await win.SegmentStream.createSender({
        blob,
        metadata: { name: 'wire.bin', mimeType: 'application/octet-stream', originalSize: blob.size },
        sessionKeys: senderKeys,
    });

    const senderControls = [];
    let chunkIndex = 0;
    const io = {
        chunkSize: 4096,
        backlogBytes: () => 0,
        sendControl: (m) => {
            senderControls.push(m);
            const handled = PA.handleControl(receiverHost, m);
            if (!handled) {
                if (m.type === 'file-start') RF.handleFileStart(m);
                else if (m.type === 'file-end') RF.handleFileEnd(m);
                else if (m.type === 'segment-rewind') RF.handleSegmentRewind(m);
            }
            return true;
        },
        sendChunk: async (chunk) => {
            const bytes = new Uint8Array(chunk);
            corrupt(chunkIndex++, bytes);
            PA.handleBinary(receiverHost, bytes.buffer);
        },
        waitForAck: () => new Promise((resolve, reject) => {
            PA.setupFileAck(senderHost, resolve, reject, 5000);
        }),
    };

    return { win, sender, io, images, receiverOut, senderControls, rxAborts };
}

test('a flipped bit on the wire heals transparently via segment-nack/rewind', async () => {
    const win = loadRealm();
    const content = patternedBytes(600 * 1024); // 3 data segments
    let corrupted = false;
    const h = await makeHarness(win, content, {
        corrupt: (i, bytes) => {
            // Chunk 0 is the whole metadata record (2072 bytes < 4096);
            // chunk 2 is inside a data record's ciphertext (which exact
            // record depends on how well the segments gzip), away from
            // any [seq][ctLen] framing header. One bit, once.
            if (i === 2 && !corrupted) {
                corrupted = true;
                bytes[100] ^= 0x01;
            }
        },
    });

    const verdict = await win.SegmentStream.transfer(h.sender, h.io, null, undefined);

    assert.equal(verdict.acknowledged, true, 'the transfer must end in a real file-ack');
    assert.equal(verdict.sha256, await h.sender.finishHash(),
        'receiver and sender must agree on the composite hash');

    assert.deepEqual(h.senderControls.map(m => m.type),
        ['file-start', 'file-end', 'segment-rewind', 'file-end'],
        'exactly one retry round, no second file-start');

    assert.deepEqual(h.receiverOut.map(m => m.type), ['segment-nack', 'file-ack'],
        'no file-nack: the user never sees the corruption');
    const nackedSeq = h.receiverOut[0].seq;
    assert.ok(nackedSeq >= 1 && nackedSeq <= h.sender.segCount,
        'the corrupted record is one of the data segments');
    assert.equal(h.senderControls[2].seq, nackedSeq, 'the rewind answers the nacked record');

    assert.equal(h.images.length, 1);
    assert.deepEqual(new Uint8Array(h.images[0].data), content,
        'the healed file must be byte-identical to the original');
    assert.equal(h.images[0].hash, verdict.sha256);
    assert.deepEqual(h.rxAborts, [], 'framing stayed intact throughout');
});

test('a clean wire still completes with no retry round', async () => {
    const win = loadRealm();
    const content = patternedBytes(100 * 1024);
    const h = await makeHarness(win, content);

    const verdict = await win.SegmentStream.transfer(h.sender, h.io, null, undefined);

    assert.equal(verdict.acknowledged, true);
    assert.deepEqual(h.senderControls.map(m => m.type), ['file-start', 'file-end']);
    assert.deepEqual(h.receiverOut.map(m => m.type), ['file-ack']);
    assert.deepEqual(new Uint8Array(h.images[0].data), content);
});

test('persistent corruption exhausts the budget and surfaces as file-nack', async () => {
    const win = loadRealm();
    const content = patternedBytes(100 * 1024); // 1 data segment
    const h = await makeHarness(win, content, {
        // Smash the tail of EVERY chunk past the metadata record, every
        // pass: a relay that corrupts everything it relays.
        corrupt: (i, bytes) => {
            if (bytes.byteLength > 2100 || i > 0) bytes[bytes.length - 1] ^= 0xff;
        },
    });

    await assert.rejects(
        () => win.SegmentStream.transfer(h.sender, h.io, null, undefined),
        /Receiver decryption failed: decrypt-failed/,
        'the receiver gives up first and file-nacks');

    const segNacks = h.receiverOut.filter(m => m.type === 'segment-nack');
    assert.equal(segNacks.length, 3, 'the receiver retried its full budget');
    assert.equal(h.receiverOut.at(-1).type, 'file-nack');
    assert.equal(h.images.length, 0);
});
