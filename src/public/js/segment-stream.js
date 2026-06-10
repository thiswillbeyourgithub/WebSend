/**
 * v2 chunked-file streaming for WebSend: turns a Blob into a stream of
 * sealed segment records on the sender and turns verified records back
 * into a Blob on the receiver. Built with Claude Code.
 *
 * Wire record (the only binary the transports carry):
 *
 *   [4B BE seq][4B BE ctLen][ct]
 *
 * Record seq 0 is the encrypted metadata record (JSON {name, mimeType,
 * originalSize}, padded to a fixed size); data segments are seq 1 to
 * segCount, each sealing exactly Protocol.SEG_SIZE plaintext bytes of the
 * file except the last (padded up to a small bucket). Sealing/opening is
 * WebSendCrypto.sealSegment/openSegment (STREAM construction: per-file
 * HKDF subkey, counter nonce, final flag).
 *
 * Memory: the sender reads one segment at a time via blob.slice(); the
 * receiver wraps each verified plaintext segment in its own Blob part so
 * the browser can spill big files to disk. Neither side ever holds the
 * whole file in an ArrayBuffer.
 *
 * Rewind rule: any rewind (in-connection retry or reconnect resume)
 * re-keys the tail with a fresh salt before resending, so a (key, nonce)
 * pair is never reused with possibly different plaintext (per-segment
 * gzip output is not guaranteed deterministic).
 */
(function () {
    /** Fixed plaintext size of the metadata record (seq 0); padded so the
     * filename length is not observable. 2 KiB fits a 255-char UTF-8 name
     * plus mime type and size with ample headroom. */
    const META_RECORD_PLAINTEXT = 2048;

    /** The final data segment is padded up to the nearest of these, hiding
     * the exact file size to bucket granularity (the segment count already
     * reveals it to SEG_SIZE granularity on the wire). */
    const FINAL_PAD_BUCKETS = [16 * 1024, 64 * 1024, 256 * 1024];

    /** [4B BE seq][4B BE ctLen] before each record's ciphertext */
    const RECORD_HEADER_BYTES = 8;

    /** AES-GCM auth tag length, for wire-size estimates */
    const GCM_TAG_BYTES = 16;

    function b64encode(bytes) {
        return btoa(String.fromCharCode(...bytes));
    }

    function b64decode(str) {
        const bin = atob(str);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function finalPadTarget(minSize) {
        for (const bucket of FINAL_PAD_BUCKETS) {
            if (minSize <= bucket) return bucket;
        }
        return minSize; // already a full-ish segment, nothing to hide
    }

    function buildRecord(seq, ct) {
        const record = new Uint8Array(RECORD_HEADER_BYTES + ct.byteLength);
        const view = new DataView(record.buffer);
        view.setUint32(0, seq, false);
        view.setUint32(4, ct.byteLength, false);
        record.set(new Uint8Array(ct), RECORD_HEADER_BYTES);
        return record.buffer;
    }

    /**
     * Sender side: pulls plaintext out of the Blob one segment at a time
     * and yields sealed wire records.
     *
     * @param {Blob} blob - The file to send
     * @param {Object} metadata - {name, mimeType, originalSize} (raw; the
     *   receiver sanitizes)
     * @param {{deriveFileKey: function}} sessionKeys - From
     *   WebSendCrypto.deriveSessionKeys
     */
    async function createSender({ blob, metadata, sessionKeys }) {
        const segSize = Protocol.SEG_SIZE;
        const segCount = Math.max(1, Math.ceil(blob.size / segSize));
        if (segCount > Protocol.MAX_SEG_COUNT) {
            throw new Error(`File too large: ${blob.size} bytes exceeds ${Protocol.MAX_SEG_COUNT} segments`);
        }

        let salt = WebSendCrypto.getRandomBytes(16);
        let fileKey = await sessionKeys.deriveFileKey(salt);
        let nextSeq = 0;
        // Per-data-segment plaintext digests for the composite file hash.
        // Indexed by segment - 1; survives rewinds (plaintext is identical).
        const digests = new Array(segCount).fill(null);

        // Upper bound on wire bytes (gzip can only shrink it): used for
        // sender progress percent/rate. Final segment counted at its padded
        // bucket size.
        const finalLen = blob.size - (segCount - 1) * segSize;
        const fullRecord = RECORD_HEADER_BYTES + WebSendCrypto.SEGMENT_HEADER_BYTES + segSize + GCM_TAG_BYTES;
        const finalRecord = RECORD_HEADER_BYTES
            + finalPadTarget(WebSendCrypto.SEGMENT_HEADER_BYTES + finalLen) + GCM_TAG_BYTES;
        const metaRecord = RECORD_HEADER_BYTES + META_RECORD_PLAINTEXT + GCM_TAG_BYTES;
        const estimatedWireSize = metaRecord + (segCount - 1) * fullRecord + finalRecord;

        return Object.freeze({
            segCount,
            totalRecords: segCount + 1,
            estimatedWireSize,
            get saltB64() { return b64encode(salt); },
            get nextSeq() { return nextSeq; },

            /**
             * Seal and return the next wire record, or null after the final
             * segment. {seq, bytes: ArrayBuffer, isFinal}.
             */
            async next() {
                if (nextSeq > segCount) return null;
                const seq = nextSeq;

                if (seq === 0) {
                    const metaBytes = new TextEncoder().encode(JSON.stringify(metadata));
                    if (WebSendCrypto.SEGMENT_HEADER_BYTES + metaBytes.length > META_RECORD_PLAINTEXT) {
                        throw new Error('File metadata too large');
                    }
                    const ct = await WebSendCrypto.sealSegment(fileKey, 0, false, metaBytes,
                        { padToSize: META_RECORD_PLAINTEXT });
                    nextSeq = 1;
                    return { seq, bytes: buildRecord(0, ct), isFinal: false };
                }

                const start = (seq - 1) * segSize;
                const chunk = await blob.slice(start, Math.min(start + segSize, blob.size)).arrayBuffer();
                if (!digests[seq - 1]) {
                    digests[seq - 1] = await WebSendCrypto.sha256Bytes(chunk);
                }
                const isFinal = seq === segCount;
                const ct = await WebSendCrypto.sealSegment(fileKey, seq, isFinal, chunk, {
                    tryGzip: true,
                    // Final-segment padding is computed from the uncompressed
                    // length so the bucket also hides the tail's compressibility.
                    padToSize: isFinal
                        ? finalPadTarget(WebSendCrypto.SEGMENT_HEADER_BYTES + chunk.byteLength)
                        : 0,
                });
                nextSeq = seq + 1;
                return { seq, bytes: buildRecord(seq, ct), isFinal };
            },

            /**
             * Reposition to resend from record {seq}, re-keying the tail
             * with a fresh salt. Returns the new salt (base64) which MUST
             * reach the receiver (segment-rewind / file-resume-ack) before
             * any resent record.
             */
            async rewind(seq) {
                if (!Number.isInteger(seq) || seq < 0 || seq > segCount) {
                    throw new Error(`Invalid rewind seq ${seq}`);
                }
                salt = WebSendCrypto.getRandomBytes(16);
                fileKey = await sessionKeys.deriveFileKey(salt);
                nextSeq = seq;
                return { saltB64: b64encode(salt) };
            },

            /**
             * Composite file hash; valid once every segment has been read
             * at least once (i.e. after next() returned the final record).
             */
            async finishHash() {
                if (digests.some(d => d === null)) {
                    throw new Error('finishHash before all segments were read');
                }
                return WebSendCrypto.finalizeCompositeHash(digests);
            },
        });
    }

    /**
     * Receiver side: verifies records in order and accumulates plaintext
     * as Blob parts.
     *
     * @param {{deriveFileKey: function}} sessionKeys
     * @param {string} saltB64 - File salt from file-start
     * @param {number} segCount - Data segment count from file-start
     */
    function createReceiver({ sessionKeys, saltB64, segCount }) {
        const segSize = Protocol.SEG_SIZE;
        let fileKeyPromise = sessionKeys.deriveFileKey(b64decode(saltB64));
        let nextSeq = 0;
        let metadata = null;
        const parts = [];   // one Blob per verified data segment
        const digests = [];

        return Object.freeze({
            segCount,
            get nextSeq() { return nextSeq; },
            get verifiedBytes() {
                return parts.reduce((sum, p) => sum + p.size, 0);
            },

            /**
             * Verify and store one record. Returns {ok:true, isLast} or
             * {ok:false, reason} ('out-of-order' | 'auth' | 'bad-length' |
             * 'metadata'). Auth covers corruption, reordering, truncation,
             * and wrong-key (stale salt) alike; the caller's retry path
             * (segment-nack) handles all of them the same way.
             */
            async accept(seq, ctBytes) {
                if (seq !== nextSeq) return { ok: false, reason: 'out-of-order' };
                const isFinal = seq === segCount;
                let payload;
                try {
                    payload = await WebSendCrypto.openSegment(await fileKeyPromise, seq, isFinal, ctBytes);
                } catch (e) {
                    return { ok: false, reason: 'auth' };
                }

                if (seq === 0) {
                    try {
                        metadata = JSON.parse(new TextDecoder().decode(payload));
                    } catch (e) {
                        return { ok: false, reason: 'metadata' };
                    }
                    nextSeq = 1;
                    return { ok: true, isLast: false };
                }

                // Non-final data segments must be exactly one window; the
                // composite hash and seq->byte-offset resume mapping depend
                // on it. The final segment is whatever remains.
                if (!isFinal && payload.byteLength !== segSize) {
                    return { ok: false, reason: 'bad-length' };
                }
                if (isFinal && payload.byteLength > segSize) {
                    return { ok: false, reason: 'bad-length' };
                }

                digests.push(await WebSendCrypto.sha256Bytes(payload));
                parts.push(new Blob([payload]));
                nextSeq = seq + 1;
                return { ok: true, isLast: isFinal };
            },

            /**
             * Apply a tail re-key (segment-rewind / file-resume-ack):
             * resend continues from {fromSeq} under the new salt. Discards
             * any segments at or past fromSeq (a rewind earlier than our
             * nextSeq invalidates them).
             */
            rekey(newSaltB64, fromSeq) {
                if (!Number.isInteger(fromSeq) || fromSeq < 0 || fromSeq > nextSeq) {
                    throw new Error(`Invalid rekey seq ${fromSeq}`);
                }
                fileKeyPromise = sessionKeys.deriveFileKey(b64decode(newSaltB64));
                if (fromSeq === 0) metadata = null;
                const keepSegments = Math.max(0, fromSeq - 1);
                parts.length = Math.min(parts.length, keepSegments);
                digests.length = Math.min(digests.length, keepSegments);
                nextSeq = fromSeq;
            },

            /**
             * Assemble the verified file. Only valid after the final
             * record was accepted. The Blob is untyped; the caller applies
             * the sanitized mime type.
             */
            async finish() {
                if (nextSeq !== segCount + 1) {
                    throw new Error(`finish() with ${nextSeq}/${segCount + 1} records verified`);
                }
                return {
                    metadata,
                    blob: new Blob(parts),
                    compositeHashHex: await WebSendCrypto.finalizeCompositeHash(digests),
                };
            },
        });
    }

    window.SegmentStream = Object.freeze({
        META_RECORD_PLAINTEXT,
        FINAL_PAD_BUCKETS,
        RECORD_HEADER_BYTES,
        createSender,
        createReceiver,
    });
})();
