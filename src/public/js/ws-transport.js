/**
 * ws-transport.js — HTTP-relay fallback transport over WebSocket.
 *
 * Mirrors the duck-typed Transport surface that webrtc.js (WebSendRTC) has
 * always exposed, so receive.html and sender-connect.js do not need to
 * branch on transport type. Connection is established only when both peers
 * have joined the relay slots ('a' / 'b'); a relay-hello handshake on top
 * of the wire signals readiness so the RacingTransport doesn't pick this
 * transport before the peer is actually reachable.
 *
 * Security model (must stay aligned with webrtc.js):
 *   - All payloads remain ECDH+AES-GCM end-to-end encrypted; the relay
 *     forwards opaque bytes and never sees plaintext.
 *   - Fingerprint verification (window.SenderConnect.isVerified, the
 *     VERIFIED_GATED_HANDLERS map in receive.html) gates application
 *     messages independent of the transport, so a future code path that
 *     wins the race here still requires the same out-of-band ceremony.
 *   - Anti-DoS bounds are mirrored from webrtc.js handleMessage:
 *       Protocol.MAX_CONTROL_MSG_BYTES (16 KiB)
 *       Protocol.MIN_FILE_START_SIZE  (16 KiB)
 *       Protocol.MAX_TOTAL_SESSION_BYTES (4 GiB)
 *     The server (server.js, commit 2) also enforces the cumulative caps
 *     so a malicious client cannot ignore them.
 *
 * IMPORTANT — duplication flag:
 *   The receive-side state machine (file-start / file-end / file-ack /
 *   file-nack / binary chunk assembly / bounds checks) and the chunked-
 *   send-with-bufferedAmount-backpressure loop are duplicated from
 *   webrtc.js. A future cleanup commit should extract a shared
 *   TransportBase (or PayloadAssembler) so both transports share one
 *   source of truth. Today the two implementations are intentionally
 *   kept in sync by hand; if you change one, change the other.
 *
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    const FILE_ACK_TIMEOUT_MS = 30_000;
    const SEND_BUFFER_HIGH_WATER = 1024 * 1024; // 1 MiB
    const CHUNK_SIZE = 16_384; // 16 KiB, same as webrtc.js
    // Soft cap on WS bufferedAmount before treating the consumer as dead.
    // The server-side 4 GiB session cap is the hard ceiling; this just
    // catches stuck pipes in the foreground before a real OOM occurs.
    const STUCK_PIPE_BYTES = 16 * 1024 * 1024;

    class WSTransport {
        constructor() {
            this.ws = null;
            this.roomId = null;
            this.roomSecret = null;

            // Compat fields read by callers that originally talked to
            // WebSendRTC. iceServers stays empty on the WS path; pc is
            // null so sender-connect's connectionLost probe falls back to
            // the WS readyState check (see isConnectionLost()).
            this.iceServers = [];
            this.pc = null;

            // Event callbacks (set by caller)
            this.onConnected = null;
            this.onDisconnected = null;
            this.onMessage = null;
            this.onStateChange = null;
            this.onConnectionTypeDetected = null;

            // Receive state — kept in lockstep with webrtc.js. See header
            // duplication flag above.
            this.receiveBuffer = [];
            this.receivedSize = 0;
            this.expectedSize = 0;
            this._lastLoggedDecile = -1;
            this._sessionTotalBytes = 0;
            this._abusiveTeardown = false;

            // File-ack state — mirrors webrtc.js sendFile() ack tracking.
            this._fileAckInFlight = false;
            this._fileAckResolve = null;
            this._fileAckReject = null;
            this._fileAckTimeout = null;

            this._connected = false;
            this._closed = false;
        }

        // Transport interface: init() is a no-op here. /api/config is
        // already fetched by the WebRTC inner in RacingTransport.init();
        // the WS transport has no per-instance config to read.
        async init() { /* no-op */ }

        /**
         * Inherit room from the WebRTC inner's createRoom() so we don't
         * double-allocate a room id. Called by RacingTransport.
         */
        setRoom(roomId, secret) {
            this.roomId = roomId;
            this.roomSecret = secret;
        }

        /** Receiver-side: open the slot-A WS. Non-blocking. */
        openSlotA() {
            this._openWs();
        }

        /** Sender-side: open the slot-B WS with explicit room info. */
        openSlotB(roomId, secret) {
            this.roomId = roomId;
            this.roomSecret = secret;
            this._openWs();
        }

        _openWs() {
            if (this.ws || this._closed) return;
            if (!this.roomId || !this.roomSecret) {
                logger.warn('[WS] openWs called without room/secret');
                return;
            }
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = `${proto}//${location.host}/api/rooms/${this.roomId}/relay`
                + `?secret=${encodeURIComponent(this.roomSecret)}`;
            logger.info(`[WS] opening relay socket to ${proto}//${location.host}/api/rooms/${this.roomId}/relay`);

            let ws;
            try {
                ws = new WebSocket(url);
            } catch (e) {
                logger.error('[WS] constructor threw: ' + e.message);
                return;
            }
            ws.binaryType = 'arraybuffer';
            this.ws = ws;

            ws.onopen = () => {
                logger.info('[WS] relay socket open; sending relay-hello');
                // Send a hello frame. The peer's relay-hello triggers
                // _markConnected on our side; the relay-hello is the only
                // protocol-level message exchanged out of band of the
                // application protocol (it never reaches onMessage).
                try { ws.send(JSON.stringify({ type: 'relay-hello' })); } catch (_) {}
            };

            ws.onmessage = (event) => this._handleFrame(event.data);

            ws.onclose = (event) => {
                if (this._closed) return; // close() initiated by us
                if (this._abusiveTeardown) return;
                logger.warn(`[WS] relay socket closed (code=${event.code} reason=${event.reason || '?'})`);
                this._connected = false;
                if (this.onStateChange) this.onStateChange('failed');
                if (this.onDisconnected) this.onDisconnected();
            };

            ws.onerror = (event) => {
                // The close event fires right after, which is where we
                // surface the disconnect. Logging here gives operators a
                // separable signal from the close-code line.
                logger.warn('[WS] relay socket error: ' + (event.message || 'unknown'));
            };
        }

        _handleFrame(data) {
            if (typeof data === 'string') {
                // Wire-level cap, same as webrtc.js. UTF-16 byte size is
                // approximated as 2*length so astral codepoints cannot
                // halve the apparent cost.
                if (data.length * 2 > window.Protocol.MAX_CONTROL_MSG_BYTES) {
                    logger.error(`[WS] dropping oversized control msg (${data.length} chars)`);
                    return;
                }
                let msg;
                try { msg = JSON.parse(data); }
                catch (e) { logger.error('[WS] bad JSON: ' + e.message); return; }

                // relay-hello is the connection-readiness signal between
                // the two peers. Once we receive one, both halves of the
                // relay are live and frames will be forwarded.
                if (msg && msg.type === 'relay-hello') {
                    if (!this._connected) this._markConnected();
                    return;
                }

                const vr = window.Protocol.validate(msg);
                if (!vr.ok) {
                    logger.error('[WS] dropping inbound message: ' + vr.error);
                    return;
                }
                logger.info(`[WS] received message type: ${msg.type}`);

                // Same file-control branches as webrtc.js handleMessage.
                if (msg.type === 'file-start') {
                    this.receiveBuffer = [];
                    this.receivedSize = 0;
                    this.expectedSize = msg.size;
                    this._lastLoggedDecile = -1;
                    logger.info(`[WS] receiving encrypted file (${msg.size} bytes, padded)`);
                } else if (msg.type === 'file-end') {
                    logger.info('[WS] file transfer complete, assembling...');
                    const blob = new Blob(this.receiveBuffer, { type: 'application/octet-stream' });
                    if (this.onMessage) this.onMessage({ type: 'encrypted-file', blob });
                    this.receiveBuffer = [];
                    this.receivedSize = 0;
                } else if (msg.type === 'file-ack') {
                    logger.info(`[WS] received file-ack with SHA-256: ${msg.sha256}`);
                    this._resolveFileAck({ acknowledged: true, sha256: msg.sha256 });
                } else if (msg.type === 'file-nack') {
                    logger.error(`[WS] received file-nack: ${msg.error}`);
                    this._rejectFileAck(new Error(`Receiver decryption failed: ${msg.error}`));
                } else if (this.onMessage) {
                    this.onMessage(msg);
                }
                return;
            }

            // Binary chunk path. Defense-in-depth bounds mirror webrtc.js:
            //   1) chunk before file-start
            //   2) cumulative chunk overflow past expectedSize
            //   3) session aggregate past MAX_TOTAL_SESSION_BYTES
            // Each tears down the WS and notifies the app via onDisconnected.
            if (this._abusiveTeardown) return;
            const buf = (data instanceof ArrayBuffer) ? data : (data && data.buffer) || data;
            const len = (buf && buf.byteLength) | 0;
            if (this.expectedSize <= 0) {
                this._abortAbusiveStream('binary chunk before file-start');
                return;
            }
            if (this.receivedSize + len > this.expectedSize) {
                this._abortAbusiveStream(
                    `chunk overflow: received ${this.receivedSize} + ${len} > expected ${this.expectedSize}`
                );
                return;
            }
            if (this._sessionTotalBytes + len > window.Protocol.MAX_TOTAL_SESSION_BYTES) {
                this._abortAbusiveStream(
                    `session byte cap exceeded (${this._sessionTotalBytes + len} > ${window.Protocol.MAX_TOTAL_SESSION_BYTES})`
                );
                return;
            }
            this.receiveBuffer.push(buf);
            this.receivedSize += len;
            this._sessionTotalBytes += len;
            const decile = Math.floor((this.receivedSize / this.expectedSize) * 10) * 10;
            if (decile !== this._lastLoggedDecile) {
                this._lastLoggedDecile = decile;
                logger.info(`[WS] receiving: ${decile}%`);
            }
            if (this.onMessage) {
                this.onMessage({
                    type: 'progress',
                    received: this.receivedSize,
                    total: this.expectedSize,
                });
            }
        }

        _markConnected() {
            this._connected = true;
            logger.success('[WS] both peers paired on the relay — connection ready');
            if (this.onStateChange) this.onStateChange('connected');
            if (this.onConnected) this.onConnected();
            if (this.onConnectionTypeDetected) {
                const isSecure = location.protocol === 'https:';
                const type = isSecure ? 'relay-https' : 'relay-http';
                const detailsKey = isSecure ? 'connection.relayHttpSecureDetails' : 'connection.relayHttpDetails';
                const details = (window.i18n && typeof window.i18n.t === 'function')
                    ? window.i18n.t(detailsKey) : detailsKey;
                this.onConnectionTypeDetected({
                    type,
                    details,
                    localType: 'relay',
                    remoteType: 'relay',
                });
            }
        }

        _abortAbusiveStream(reason) {
            if (this._abusiveTeardown) return;
            this._abusiveTeardown = true;
            logger.error(`[WS] aborting relay session: ${reason}`);
            this.receiveBuffer = [];
            this.receivedSize = 0;
            this.expectedSize = 0;
            try { if (this.ws) this.ws.close(1008, 'Protocol violation'); } catch (_) {}
            if (this.onDisconnected) { try { this.onDisconnected(); } catch (_) {} }
        }

        sendMessage(message) {
            if (!this._isOpen()) {
                logger.error('[WS] not open, cannot send message');
                return false;
            }
            const vr = window.Protocol.validate(message);
            if (!vr.ok) {
                logger.error('[WS] refusing to send invalid message: ' + vr.error);
                return false;
            }
            this.ws.send(JSON.stringify(message));
            return true;
        }

        async sendFile(encryptedData, onProgress) {
            if (!this._isOpen()) {
                logger.error('[WS] not open, cannot send file');
                return false;
            }
            if (this._fileAckInFlight) {
                throw new Error('sendFile already in progress — wait for the previous transfer to finish');
            }
            this._fileAckInFlight = true;

            try {
                const totalSize = encryptedData.byteLength;
                let offset = 0;

                if (!this.sendMessage(window.Protocol.build.fileStart(totalSize))) {
                    throw new Error('Failed to send file-start (WS not open)');
                }
                logger.info(`[WS] sending encrypted file (${totalSize} bytes, padded)`);

                while (offset < totalSize) {
                    // Backpressure via WS bufferedAmount. If buffered keeps
                    // climbing past STUCK_PIPE_BYTES, the consumer is dead;
                    // give up rather than hold the file in browser memory
                    // forever.
                    while (this.ws.bufferedAmount > SEND_BUFFER_HIGH_WATER) {
                        if (this.ws.bufferedAmount > STUCK_PIPE_BYTES) {
                            throw new Error(`WS stuck (bufferedAmount=${this.ws.bufferedAmount})`);
                        }
                        await new Promise(r => setTimeout(r, 50));
                    }
                    if (!this._isOpen()) {
                        throw new Error('WS closed mid-transfer');
                    }
                    const chunk = encryptedData.slice(offset, offset + CHUNK_SIZE);
                    this.ws.send(chunk);
                    offset += chunk.byteLength;
                    const percent = Math.round((offset / totalSize) * 100);
                    if (onProgress) onProgress(percent, offset, totalSize);
                }

                if (!this.sendMessage(window.Protocol.build.fileEnd())) {
                    throw new Error('Failed to send file-end');
                }
                logger.info('[WS] all chunks sent, waiting for receiver acknowledgment...');

                return await new Promise((resolve, reject) => {
                    this._fileAckResolve = resolve;
                    this._fileAckReject = reject;
                    this._fileAckTimeout = setTimeout(() => {
                        this._rejectFileAck(new Error(
                            'Transfer acknowledgment timeout — no confirmation from receiver after 30s'
                        ));
                    }, FILE_ACK_TIMEOUT_MS);
                });
            } finally {
                this._fileAckInFlight = false;
            }
        }

        _clearFileAckState() {
            if (this._fileAckTimeout) {
                clearTimeout(this._fileAckTimeout);
                this._fileAckTimeout = null;
            }
            this._fileAckResolve = null;
            this._fileAckReject = null;
        }

        _resolveFileAck(value) {
            const resolve = this._fileAckResolve;
            this._clearFileAckState();
            if (resolve) resolve(value);
        }

        _rejectFileAck(err) {
            const reject = this._fileAckReject;
            this._clearFileAckState();
            if (reject) reject(err);
        }

        _isOpen() {
            return !!this.ws && this.ws.readyState === WebSocket.OPEN;
        }

        isConnected() { return this._connected; }

        close() {
            this._closed = true;
            if (this._fileAckReject) {
                this._fileAckReject(new Error('Connection closed before receiver acknowledged transfer'));
                this._clearFileAckState();
            }
            if (this.ws) {
                try { this.ws.close(1000, 'Client closing'); } catch (_) {}
                this.ws = null;
            }
            this.receiveBuffer = [];
            this.receivedSize = 0;
            this.expectedSize = 0;
            this._sessionTotalBytes = 0;
            this._abusiveTeardown = false;
            this._connected = false;
        }
    }

    window.WSTransport = WSTransport;
})();
