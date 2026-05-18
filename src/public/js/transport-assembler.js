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
    }

    function resetReceive(host) {
        host.receiveBuffer = [];
        host.receivedSize = 0;
        host.expectedSize = 0;
        host._sessionTotalBytes = 0;
        host._abusiveTeardown = false;
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
            host.expectedSize = msg.size;
            host._lastLoggedDecile = -1;
            logger.info(`[${host.tag}] receiving encrypted file (${msg.size} bytes, padded)`);
            return true;
        }
        if (msg.type === 'file-end') {
            logger.info(`[${host.tag}] file transfer complete, assembling...`);
            const blob = new Blob(host.receiveBuffer, { type: 'application/octet-stream' });
            if (host.onMessage) host.onMessage({ type: 'encrypted-file', blob });
            host.receiveBuffer = [];
            host.receivedSize = 0;
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

    function handleBinary(host, buf) {
        if (host._abusiveTeardown) return;
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
