/**
 * transport-assembler.js, shared receive-state machine for all transports.
 *
 * The WS, LP, and WebRTC transports all need the same chunk-assembly state
 * machine (file-start / binary chunks / file-end / file-ack / file-nack)
 * plus the same anti-DoS bounds (MAX_TOTAL_SESSION_BYTES, MAX_CONTROL_MSG_BYTES,
 * MIN_FILE_START_SIZE indirectly via expectedSize). Without a shared module
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
 *   receiveBuffer, receivedSize, expectedSize, _lastLoggedDecile,
 *   _sessionTotalBytes, _abusiveTeardown, _fileAckResolve, _fileAckReject,
 *   _fileAckTimeout.
 *
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    function initState(host) {
        host.receiveBuffer = [];
        host.receivedSize = 0;
        host.expectedSize = 0;
        host._lastLoggedDecile = -1;
        host._sessionTotalBytes = 0;
        host._abusiveTeardown = false;
        host._fileAckResolve = null;
        host._fileAckReject = null;
        host._fileAckTimeout = null;
        clearV2Parser(host);
    }

    function resetReceive(host) {
        host.receiveBuffer = [];
        host.receivedSize = 0;
        host.expectedSize = 0;
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

    // Resume helpers: a transient transport drop must preserve the
    // in-flight file-start buffer so we can byte-level-resume after
    // reconnect. Callers gate on these helpers; resetReceive() above
    // is reserved for explicit teardown (cleanup / startNewPairing /
    // a fresh file-start that invalidates the in-flight one).

    function hasInflightTransfer(host) {
        return host.expectedSize > 0 && host.receivedSize < host.expectedSize;
    }

    function getResumeState(host) {
        if (!hasInflightTransfer(host)) return null;
        return { size: host.expectedSize, received: host.receivedSize };
    }

    // Sender-side: called when our peer responds to file-resume-offer
    // with file-resume-ack {offset: 0} (sender cannot or chose not to
    // resume; expect a fresh file-start). Drops the partial buffer
    // without touching the session-byte counter, which is independent
    // of any particular file.
    function discardInflightOnResumeReset(host) {
        host.receiveBuffer = [];
        host.receivedSize = 0;
        host.expectedSize = 0;
        host._lastLoggedDecile = -1;
    }

    // Consume a control-frame message (already parsed + Protocol.validate'd).
    // Returns true if the assembler handled it (file-start / file-end /
    // file-ack / file-nack); returns false if the caller should forward it
    // to onMessage.
    function handleControl(host, msg) {
        if (msg.type === 'file-start') {
            host.receiveBuffer = [];
            host.receivedSize = 0;
            host._lastLoggedDecile = -1;
            if (msg.v === 2) {
                // v2 chunked format: the assembler stays crypto-free and
                // only frames [4B BE seq][4B BE ctLen][ct] records out of
                // the byte stream. Decrypt/verify happens above the
                // verification gate (ReceiveFlow + SegmentReceiver), so
                // file-start must be forwarded upward for gating.
                host.expectedSize = 0;
                host._v2Mode = true;
                host._v2Pending = null;
                host._v2NextSeq = 0;
                host._v2ExpectedRecords = msg.segCount + 1;
                host._v2WireBytes = 0;
                // Wire-size estimate for byte-based rate/ETA display
                // (upper bound: gzip only shrinks records; percent should
                // use the exact seq/segCount fields on progress events).
                host._v2WireEstimate = host._v2ExpectedRecords
                    * (window.Protocol.SEG_SIZE + V2_RECORD_OVERHEAD);
                logger.info(`[${host.tag}] receiving v2 chunked file (${msg.segCount} segments)`);
                return false;
            }
            clearV2Parser(host);
            host.expectedSize = msg.size;
            logger.info(`[${host.tag}] receiving encrypted file (${msg.size} bytes, padded)`);
            return true;
        }
        if (msg.type === 'file-end' && host._v2Mode) {
            // v2: completeness is judged by the SegmentReceiver (it knows
            // how many records verified), so forward upward.
            logger.info(`[${host.tag}] v2 file-end after ${host._v2WireBytes} wire bytes`);
            return false;
        }
        if (msg.type === 'file-end') {
            // Bytes went missing in transit (chunks carry no sequence
            // numbers, so this is the first place a loss is detectable).
            // Don't hand the short blob to the decrypt path: AES-GCM would
            // fail anyway and the sender would see an opaque "decryption
            // failed" instead of the actionable "data was lost, retry".
            if (host.receivedSize !== host.expectedSize) {
                logger.error(`[${host.tag}] file-end after ${host.receivedSize}/${host.expectedSize} bytes; transfer incomplete`);
                if (host.onMessage) {
                    host.onMessage({
                        type: 'file-incomplete',
                        received: host.receivedSize,
                        expected: host.expectedSize,
                    });
                }
                host.receiveBuffer = [];
                host.receivedSize = 0;
                host.expectedSize = 0;
                return true;
            }
            logger.info(`[${host.tag}] file transfer complete, assembling...`);
            const blob = new Blob(host.receiveBuffer, { type: 'application/octet-stream' });
            if (host.onMessage) host.onMessage({ type: 'encrypted-file', blob });
            host.receiveBuffer = [];
            host.receivedSize = 0;
            // Also clear expectedSize: the transfer is over. Leaving it set
            // made hasInflightTransfer() true again (receivedSize dropped
            // back to 0), so a reconnect after a *completed* transfer sent
            // the sender a bogus file-resume-offer {received: 0}.
            host.expectedSize = 0;
            return true;
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

    function handleBinary(host, buf) {
        if (host._abusiveTeardown) return;
        if (host._v2Mode) {
            handleBinaryV2(host, buf);
            return;
        }
        const len = (buf && buf.byteLength) | 0;
        if (host.expectedSize <= 0) {
            abortAbusiveStream(host, 'binary chunk before file-start');
            return;
        }
        if (host.receivedSize + len > host.expectedSize) {
            abortAbusiveStream(host,
                `chunk overflow: received ${host.receivedSize} + ${len} > expected ${host.expectedSize}`);
            return;
        }
        if (host._sessionTotalBytes + len > window.Protocol.MAX_TOTAL_SESSION_BYTES) {
            abortAbusiveStream(host,
                `session byte cap exceeded (${host._sessionTotalBytes + len} > ${window.Protocol.MAX_TOTAL_SESSION_BYTES})`);
            return;
        }
        host.receiveBuffer.push(buf);
        host.receivedSize += len;
        host._sessionTotalBytes += len;
        const decile = Math.floor((host.receivedSize / host.expectedSize) * 10) * 10;
        if (decile !== host._lastLoggedDecile) {
            host._lastLoggedDecile = decile;
            logger.info(`[${host.tag}] receiving: ${decile}%`);
        }
        if (host.onMessage) {
            host.onMessage({
                type: 'progress',
                received: host.receivedSize,
                total: host.expectedSize,
            });
        }
    }

    function abortAbusiveStream(host, reason) {
        if (host._abusiveTeardown) return;
        host._abusiveTeardown = true;
        logger.error(`[${host.tag}] aborting transport: ${reason}`);
        host.receiveBuffer = [];
        host.receivedSize = 0;
        host.expectedSize = 0;
        if (typeof host._abortTransport === 'function') {
            try { host._abortTransport(reason); } catch (_) {}
        }
        if (typeof host.onDisconnected === 'function') {
            try { host.onDisconnected(); } catch (_) {}
        }
    }

    function setupFileAck(host, resolve, reject, timeoutMs) {
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
        abortAbusiveStream,
        setupFileAck,
        clearFileAckState,
        resolveFileAck,
        rejectFileAck,
        hasInflightTransfer,
        getResumeState,
        discardInflightOnResumeReset,
    });
})();
