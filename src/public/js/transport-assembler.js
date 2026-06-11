/**
 * transport-assembler.js, shared receive-state machine for all transports.
 *
 * The WS, LP, and WebRTC transports all need the same crypto-free record
 * parser (file-start / binary record framing / file-end / file-ack /
 * file-nack) plus the same anti-DoS bounds (MAX_TOTAL_SESSION_BYTES,
 * MAX_CONTROL_MSG_BYTES, record-length bounds). Without a shared module
 * this code lived in three places verbatim, which is fragile (a fix in one
 * transport can silently miss the others).
 *
 * Design: pure-function API operating on a `host` instance (the transport
 * itself). The host must provide:
 *   - tag (string)                          for log lines, e.g. 'WS' / 'LP' / 'RTC'
 *   - onMessage(msg)                        the caller's message sink
 *   - _abortTransport(reason)               tear down the transport (close
 *                                           socket, cancel polling, close
 *                                           data channel + peer connection,
 *                                           etc.). Called when a protocol
 *                                           violation or session-byte-cap
 *                                           event aborts the stream.
 * After PayloadAssembler.initState(host), the host gains these fields:
 *   _lastLoggedDecile, _sessionTotalBytes, _abusiveTeardown,
 *   _fileAckResolve, _fileAckReject, _fileAckTimeout, _segmentNackSeq,
 *   and the _v2* record parser fields.
 *
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    function initState(host) {
        host._lastLoggedDecile = -1;
        host._sessionTotalBytes = 0;
        host._abusiveTeardown = false;
        host._fileAckResolve = null;
        host._fileAckReject = null;
        host._fileAckTimeout = null;
        host._segmentNackSeq = null;
        clearV2Parser(host);
    }

    function resetReceive(host) {
        host._sessionTotalBytes = 0;
        host._abusiveTeardown = false;
        clearV2Parser(host);
    }

    function clearV2Parser(host) {
        host._v2Mode = false;
        host._v2Pending = null;
        host._v2NextSeq = 0;
        host._v2ExpectedRecords = 0;
        host._v2WireBytes = 0;
        host._v2WireEstimate = 0;
    }

    // Consume a control-frame message (already parsed + Protocol.validate'd).
    // Returns true if the assembler handled it (file-ack / file-nack);
    // returns false if the caller should forward it to onMessage.
    function handleControl(host, msg) {
        if (msg.type === 'file-start') {
            host._lastLoggedDecile = -1;
            if (msg.v === 2) {
                // v2 chunked format: the assembler stays crypto-free and
                // only frames [4B BE seq][4B BE ctLen][ct] records out of
                // the byte stream. Decrypt/verify happens above the
                // verification gate (ReceiveFlow + SegmentReceiver), so
                // file-start must be forwarded upward for gating.
                armV2Parser(host, msg.segCount, 0);
                logger.info(`[${host.tag}] receiving v2 chunked file (${msg.segCount} segments)`);
                return false;
            }
            // Unknown/legacy version: forward upward so the receive flow
            // answers file-nack('unsupported-version'). The parser stays
            // disarmed; any binary that follows aborts the stream.
            clearV2Parser(host);
            logger.warn(`[${host.tag}] file-start with unsupported version (v=${msg.v})`);
            return false;
        }
        if (msg.type === 'file-end') {
            // Completeness is judged by the SegmentReceiver (it knows how
            // many records verified), so forward upward.
            logger.info(`[${host.tag}] file-end after ${host._v2WireBytes} wire bytes`);
            return false;
        }
        if (msg.type === 'file-ack') {
            logger.info(`[${host.tag}] received file-ack with SHA-256: ${msg.sha256}`);
            resolveFileAck(host, { acknowledged: true, sha256: msg.sha256 });
            return true;
        }
        if (msg.type === 'file-nack') {
            logger.error(`[${host.tag}] received file-nack: ${msg.error}`);
            rejectFileAck(host, new Error(`Receiver decryption failed: ${msg.error}`));
            return true;
        }
        if (msg.type === 'segment-nack') {
            // The receiver rejected (or never got) records from msg.seq;
            // the sendFile tail (SegmentStream.transfer) answers with a
            // rewind. The nack can arrive while records are still being
            // pumped, before the ack waiter exists, so it is stored on
            // the host until setupFileAck picks it up.
            logger.warn(`[${host.tag}] segment-nack: receiver needs records from seq ${msg.seq}`);
            if (host._fileAckResolve) {
                resolveFileAck(host, { segmentNack: msg.seq });
            } else {
                host._segmentNackSeq = msg.seq;
            }
            return true;
        }
        return false;
    }

    // [4B BE seq][4B BE ctLen] header plus the GCM tag and the sealed
    // [1B flags][4B dataLen] segment header: every byte of a record that
    // is not segment payload.
    const V2_RECORD_OVERHEAD = 8 + 16 + 5;

    // Largest legal record ciphertext: a full segment's plaintext
    // ([1B flags][4B dataLen] + SEG_SIZE bytes) plus the 16-byte GCM tag.
    // The metadata record (2 KiB + tag) is far below this. Anything bigger
    // is a hostile or desynced stream.
    function v2MaxRecordCt() {
        return window.Protocol.SEG_SIZE + 21;
    }

    // Streaming record parser. Records may span transport chunks and one
    // chunk may carry several records; at most one partial record is ever
    // buffered (hard-bounded by v2MaxRecordCt), so an unverified or
    // hostile peer cannot grow receiver memory by streaming binary.
    function handleBinaryV2(host, buf) {
        const len = (buf && buf.byteLength) | 0;
        if (host._sessionTotalBytes + len > window.Protocol.MAX_TOTAL_SESSION_BYTES) {
            abortAbusiveStream(host,
                `session byte cap exceeded (${host._sessionTotalBytes + len} > ${window.Protocol.MAX_TOTAL_SESSION_BYTES})`);
            return;
        }
        host._sessionTotalBytes += len;
        host._v2WireBytes += len;

        const pendingLen = host._v2Pending ? host._v2Pending.length : 0;
        const merged = new Uint8Array(pendingLen + len);
        if (pendingLen) merged.set(host._v2Pending, 0);
        merged.set(new Uint8Array(buf), pendingLen);

        const maxCt = v2MaxRecordCt();
        let offset = 0;
        while (merged.length - offset >= 8) {
            const view = new DataView(merged.buffer, offset);
            const seq = view.getUint32(0, false);
            const ctLen = view.getUint32(4, false);
            if (ctLen < 16 || ctLen > maxCt) {
                abortAbusiveStream(host, `record ciphertext length ${ctLen} out of bounds`);
                return;
            }
            // seq must never skip forward: over an ordered transport that
            // means framing desync. Going backward is legitimate (the
            // sender rewinds after a segment-nack or a reconnect resume).
            if (seq > host._v2NextSeq) {
                abortAbusiveStream(host, `record seq ${seq} skipped ahead of expected ${host._v2NextSeq}`);
                return;
            }
            if (merged.length - offset < 8 + ctLen) break; // partial record
            const ct = merged.slice(offset + 8, offset + 8 + ctLen);
            offset += 8 + ctLen;
            host._v2NextSeq = seq + 1;
            if (host.onMessage) host.onMessage({ type: 'file-segment', seq, ct: ct.buffer });
        }
        host._v2Pending = offset < merged.length ? merged.slice(offset) : null;

        const lastSeq = host._v2NextSeq - 1;
        const decile = Math.floor((host._v2NextSeq / host._v2ExpectedRecords) * 10) * 10;
        if (decile !== host._lastLoggedDecile) {
            host._lastLoggedDecile = decile;
            logger.info(`[${host.tag}] receiving: ${decile}%`);
        }
        if (host.onMessage) {
            host.onMessage({
                type: 'progress',
                received: host._v2WireBytes,
                total: host._v2WireEstimate,
                seq: lastSeq,
                segCount: host._v2ExpectedRecords - 1,
            });
        }
    }

    // Reconnect/rewind hygiene: half a record left in the pending buffer
    // is garbage once the sender rewinds to a record boundary. Callers
    // pass the seq the stream will continue from.
    function resetParser(host, nextSeq) {
        if (!host._v2Mode) return;
        host._v2Pending = null;
        host._v2NextSeq = nextSeq;
    }

    // (Re-)arm the v2 record parser on {host}. Two callers: a v2
    // file-start (nextSeq 0), and the reconnect resume path, where the
    // post-reconnect winner is a fresh transport object whose parser
    // never saw the file-start, so records would otherwise be rejected
    // as "binary chunk before file-start". Wire-byte progress restarts
    // at 0; the receiver's percent display uses the exact seq/segCount
    // fields on progress events, the byte fields only feed rate/ETA.
    function armV2Parser(host, segCount, nextSeq) {
        host._v2Mode = true;
        host._v2Pending = null;
        host._v2NextSeq = nextSeq;
        host._v2ExpectedRecords = segCount + 1;
        host._v2WireBytes = 0;
        // Wire-size estimate for byte-based rate/ETA display (upper
        // bound: gzip only shrinks records).
        host._v2WireEstimate = host._v2ExpectedRecords
            * (window.Protocol.SEG_SIZE + V2_RECORD_OVERHEAD);
        host._lastLoggedDecile = -1;
    }

    function handleBinary(host, buf) {
        if (host._abusiveTeardown) return;
        if (!host._v2Mode) {
            abortAbusiveStream(host, 'binary chunk before file-start');
            return;
        }
        handleBinaryV2(host, buf);
    }

    function abortAbusiveStream(host, reason) {
        if (host._abusiveTeardown) return;
        host._abusiveTeardown = true;
        logger.error(`[${host.tag}] aborting transport: ${reason}`);
        clearV2Parser(host);
        if (typeof host._abortTransport === 'function') {
            try { host._abortTransport(reason); } catch (_) {}
        }
        if (typeof host.onDisconnected === 'function') {
            try { host.onDisconnected(); } catch (_) {}
        }
    }

    function setupFileAck(host, resolve, reject, timeoutMs) {
        if (Number.isInteger(host._segmentNackSeq)) {
            // A segment-nack arrived while records were still going out;
            // deliver it to the retry tail instead of waiting for an ack
            // that will never come.
            const seq = host._segmentNackSeq;
            host._segmentNackSeq = null;
            resolve({ segmentNack: seq });
            return;
        }
        host._fileAckResolve = resolve;
        host._fileAckReject = reject;
        host._fileAckTimeout = setTimeout(() => {
            rejectFileAck(host, new Error(
                'Transfer acknowledgment timeout, no confirmation from receiver after 30s'
            ));
        }, timeoutMs);
    }

    function clearFileAckState(host) {
        if (host._fileAckTimeout) {
            clearTimeout(host._fileAckTimeout);
            host._fileAckTimeout = null;
        }
        host._fileAckResolve = null;
        host._fileAckReject = null;
    }

    function resolveFileAck(host, value) {
        const resolve = host._fileAckResolve;
        clearFileAckState(host);
        if (resolve) resolve(value);
    }

    function rejectFileAck(host, err) {
        const reject = host._fileAckReject;
        clearFileAckState(host);
        if (reject) reject(err);
    }

    window.PayloadAssembler = Object.freeze({
        initState,
        resetReceive,
        handleControl,
        handleBinary,
        resetParser,
        armV2Parser,
        abortAbusiveStream,
        setupFileAck,
        clearFileAckState,
        resolveFileAck,
        rejectFileAck,
    });
})();
