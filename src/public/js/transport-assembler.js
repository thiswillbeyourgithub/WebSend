/**
 * transport-assembler.js, shared receive-state machine for relay transports.
 *
 * The WS and LP relay transports both need the same chunk-assembly state
 * machine (file-start / binary chunks / file-end / file-ack / file-nack)
 * plus the same anti-DoS bounds (MAX_TOTAL_SESSION_BYTES, MAX_CONTROL_MSG_BYTES,
 * MIN_FILE_START_SIZE indirectly via expectedSize). Without a shared module
 * this code lived in two places verbatim, which is fragile (a fix in one
 * transport can silently miss the other).
 *
 * Note: webrtc.js still has its own copy of this logic, tangled with the
 * data-channel-specific code. Extracting it from webrtc.js is a larger
 * refactor and is deliberately out of scope here, but a future cleanup
 * should pull webrtc.js into this same module so there is one source of
 * truth across all three transports.
 *
 * Design: pure-function API operating on a `host` instance (the transport
 * itself). The host must provide:
 *   - tag (string)                          for log lines, e.g. 'WS' / 'LP'
 *   - onMessage(msg)                        the caller's message sink
 *   - _abortTransport(reason)               tear down the transport (close
 *                                           socket, cancel polling, etc.).
 *                                           Called when a protocol-violation
 *                                           or session-byte-cap event aborts
 *                                           the stream.
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
        logger.error(`[${host.tag}] aborting relay session: ${reason}`);
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
    });
})();
