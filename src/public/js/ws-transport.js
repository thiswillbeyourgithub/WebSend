/**
 * ws-transport.js, HTTP-relay fallback transport over WebSocket.
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
 *       Protocol.MAX_TOTAL_SESSION_BYTES (4 GiB)
 *     The server (server.js, commit 2) also enforces the cumulative caps
 *     so a malicious client cannot ignore them.
 *
 * Receive-state-machine: delegated to window.PayloadAssembler so the
 * WS and LP transports share one implementation (see transport-assembler.js).
 * webrtc.js still keeps its own copy entangled with the data-channel code;
 * a future cleanup commit should pull that into PayloadAssembler too.
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

    // A WS drop mid-sendFile throws the shared window.TransientDisconnectError
    // (defined in segment-stream.js) so SenderSend can pause for resume.

    class WSTransport {
        constructor() {
            this.tag = 'WS';
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
            // Transient drop: the underlying socket closed unexpectedly
            // but the higher layer can retry without tearing down the
            // crypto / pairing state. RacingTransport wires this to the
            // reconnect loop; onDisconnected stays reserved for the
            // explicit close() path.
            this.onTransientDisconnect = null;
            this.onMessage = null;
            this.onStateChange = null;
            this.onConnectionTypeDetected = null;

            // Receive state + file-ack state are managed by PayloadAssembler.
            window.PayloadAssembler.initState(this);
            this._fileAckInFlight = false;

            // Last relay-backlog report from the server: bytes the relay
            // accepted from us that the peer has not drained yet (the WS
            // analogue of LP's X-Peer-Backlog-Bytes header). Added to
            // bufferedAmount in sendFile's backlogBytes so the progress
            // display reports delivered bytes; without it the sender ran
            // up to the server's 8 MiB peer buffer ahead of the receiver
            // (roughly a 2x rate gap on asymmetric links). Display-only.
            this._peerBacklogBytes = 0;

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

        /**
         * Re-open the same WS slot after a transient drop. The room id /
         * secret are kept from the previous session so the same slot
         * (a or b) is claimed again. Receive state in PayloadAssembler is
         * deliberately NOT reset here — that's what makes the byte-level
         * resume protocol possible.
         *
         * The server-side relay slot was torn down on the previous WS
         * close, so the rejoin allocates a fresh slot. The per-pairing
         * session-byte cap restarts at zero on the server, which is
         * acceptable: the receiver's own _sessionTotalBytes still grows
         * across reconnects and enforces the same 4 GiB ceiling locally.
         */
        reopen() {
            if (this._closed) return;
            if (this.ws) return; // already open
            this._connected = false;
            this._openWs();
        }

        _openWs() {
            if (this.ws || this._closed) return;
            if (!this.roomId || !this.roomSecret) {
                logger.warn('[WS] openWs called without room/secret');
                return;
            }
            // Fresh socket = fresh server-side relay slot, whose peer
            // buffer starts empty; a stale backlog figure from the old
            // slot would deflate the next transfer's progress.
            this._peerBacklogBytes = 0;
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
                this._logRelayFailure(event.code, event.reason);
                const hadConnected = this._connected;
                this._connected = false;
                this.ws = null;
                if (this.onStateChange) this.onStateChange('failed');
                // Only treat the close as transient if we had actually
                // reached _markConnected. A close before relay-hello (the
                // common corp-proxy "accept the upgrade then drop it"
                // pattern) must surface as onDisconnected so the
                // RacingTransport falls back to the LP transport instead
                // of silently dropping the signal in _handleInnerTransient.
                if (hadConnected && this.onTransientDisconnect) {
                    this.onTransientDisconnect();
                } else if (this.onDisconnected) {
                    this.onDisconnected();
                } else if (this.onTransientDisconnect) {
                    this.onTransientDisconnect();
                }
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
                    if (!this._connected) {
                        // Echo back: the peer that opened its slot first
                        // sent its hello while we were absent and the
                        // server dropped it on the floor (no peer yet).
                        // Without this echo, only the second-to-join peer
                        // ever marks connected. The !_connected guard
                        // prevents ping-pong.
                        try {
                            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                                this.ws.send(JSON.stringify({ type: 'relay-hello' }));
                            }
                        } catch (_) {}
                        this._markConnected();
                    }
                    return;
                }

                // Server-side backlog report (see _peerBacklogBytes).
                // Like relay-hello this never reaches onMessage. The
                // relay forwards peer frames verbatim, so a hostile peer
                // could forge one; the value only skews the local rate
                // display, the same trust class as relay-hello itself.
                if (msg && msg.type === 'relay-backlog') {
                    const bytes = Number(msg.bytes);
                    this._peerBacklogBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
                    return;
                }

                const vr = window.Protocol.validate(msg);
                if (!vr.ok) {
                    logger.error('[WS] dropping inbound message: ' + vr.error);
                    return;
                }
                logger.info(`[WS] received message type: ${msg.type}`);
                if (!window.PayloadAssembler.handleControl(this, msg)) {
                    if (this.onMessage) this.onMessage(msg);
                }
                return;
            }
            const buf = (data instanceof ArrayBuffer) ? data : (data && data.buffer) || data;
            window.PayloadAssembler.handleBinary(this, buf);
        }

        _abortTransport(_reason) {
            try { if (this.ws) this.ws.close(1008, 'Protocol violation'); } catch (_) {}
        }

        _logRelayFailure(code, reason) {
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = this.roomId ? `${proto}//${location.host}/api/rooms/${this.roomId}/relay` : '(no room)';
            logger.warn('=== RELAY FAILURE DIAGNOSTICS (WS) ===');
            logger.warn(`  URL: ${url}`);
            logger.warn(`  Close: code=${code} reason=${reason || '?'}`);
            logger.warn(`  Session bytes received: ${this._sessionTotalBytes}`);
            logger.warn(`  Last record seq expected: ${this._v2Mode ? this._v2NextSeq : '(no transfer)'}`);
            logger.warn(`  Buffered amount on close: ${this.ws ? this.ws.bufferedAmount : '?'}`);
        }

        _markConnected() {
            this._connected = true;
            logger.success('[WS] both peers paired on the relay, connection ready');
            if (this.onStateChange) this.onStateChange('connected');
            if (this.onConnected) this.onConnected();
            if (this.onConnectionTypeDetected) {
                const isSecure = location.protocol === 'https:';
                const type = isSecure ? 'relay-https' : 'relay-http';
                const detailsKey = isSecure ? 'connection.relayHttpSecureDetails' : 'connection.relayHttpDetails';
                // i18n is a script-scope global (not a window property), so we
                // reference it by name. typeof guards against load-order quirks.
                const details = (typeof i18n !== 'undefined' && typeof i18n.t === 'function')
                    ? i18n.t(detailsKey) : detailsKey;
                this.onConnectionTypeDetected({
                    type,
                    details,
                    localType: 'relay',
                    remoteType: 'relay',
                });
            }
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

        /**
         * Send (or resume sending) a file as sealed v2 records.
         *
         * SegmentStream.pump owns the record/control flow; this transport
         * supplies WS chunking, bufferedAmount backpressure, and drop
         * detection. When `resumeFromSeq > 0`, no file-start is sent (the
         * receiver kept its verified segments and was re-keyed via
         * file-resume-ack before this call).
         *
         * On a transient WS drop, throws TransientDisconnectError tagged
         * with the record seq to resume from so SenderSend can keep the
         * head of the queue and answer the receiver's file-resume-offer
         * after reconnect.
         */
        async sendFile(segmentSender, onProgress, resumeFromSeq) {
            if (!this._isOpen()) {
                // Throwing (instead of the old `return false`) matters:
                // a falsy resolve let sendOnePhoto fall through to its
                // "Transfer complete" log and finishHash(), failing the
                // file and dropping it from the queue even though no
                // byte ever left this host.
                logger.error('[WS] not open, cannot send file');
                const err = new window.TransientDisconnectError(
                    'WS not open at sendFile start', resumeFromSeq || 0);
                if (!resumeFromSeq) err.beforeFileStart = true;
                throw err;
            }
            if (this._fileAckInFlight) {
                throw new Error('sendFile already in progress, wait for the previous transfer to finish');
            }
            this._fileAckInFlight = true;
            // Forget any segment-nack left over from a previous, concluded
            // transfer; only nacks for THIS transfer may trigger a rewind.
            this._segmentNackSeq = null;

            try {
                const io = {
                    chunkSize: CHUNK_SIZE,
                    sendControl: (message) => this.sendMessage(message),
                    // Report bytes actually delivered to the peer, not bytes
                    // buffered locally or inside the relay: local
                    // bufferedAmount plus the server's relay-backlog report
                    // (bytes the relay accepted that the peer hasn't drained,
                    // up to its 8 MiB buffer). Keeps the sender's % and rate
                    // tracking the receiver's display.
                    backlogBytes: () => (this.ws ? this.ws.bufferedAmount : 0)
                        + this._peerBacklogBytes,
                    sendChunk: async (chunk) => {
                        // Backpressure via WS bufferedAmount. If buffered keeps
                        // climbing past STUCK_PIPE_BYTES, the consumer is dead;
                        // give up rather than hold the stream open forever.
                        while (this.ws && this.ws.bufferedAmount > SEND_BUFFER_HIGH_WATER) {
                            if (this.ws.bufferedAmount > STUCK_PIPE_BYTES) {
                                throw new Error(`WS stuck (bufferedAmount=${this.ws.bufferedAmount})`);
                            }
                            await new Promise(r => setTimeout(r, 50));
                        }
                        if (!this._isOpen()) {
                            throw new window.TransientDisconnectError('WS closed mid-transfer');
                        }
                        this.ws.send(chunk);
                    },
                    // Receiver verdict: file-ack value, or {segmentNack: seq}.
                    waitForAck: () => new Promise((resolve, reject) => {
                        window.PayloadAssembler.setupFileAck(this, resolve, reject, FILE_ACK_TIMEOUT_MS);
                    }),
                };
                // transfer() owns the record pump, the file-end, and the
                // segment-nack → rewind → resend retry tail.
                return await window.SegmentStream.transfer(segmentSender, io, onProgress, resumeFromSeq);
            } finally {
                this._fileAckInFlight = false;
            }
        }

        _isOpen() {
            return !!this.ws && this.ws.readyState === WebSocket.OPEN;
        }

        isConnected() { return this._connected; }

        close() {
            this._closed = true;
            if (this._fileAckReject) {
                window.PayloadAssembler.rejectFileAck(this, new Error(
                    'Connection closed before receiver acknowledged transfer'));
            }
            if (this.ws) {
                try { this.ws.close(1000, 'Client closing'); } catch (_) {}
                this.ws = null;
            }
            window.PayloadAssembler.resetReceive(this);
            this._connected = false;
        }
    }

    window.WSTransport = WSTransport;
})();
