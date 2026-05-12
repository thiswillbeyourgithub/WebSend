/**
 * lp-transport.js — long-poll HTTP-relay fallback transport.
 *
 * Used when the WS upgrade is refused or silently torn down by a hostile
 * proxy. Wire format is identical to ws-transport.js (same control
 * messages, same binary chunks, same relay-hello handshake), but the
 * transport is three pure-HTTP endpoints:
 *
 *   POST /api/rooms/:id/relay/handshake -> { slot, token }
 *   POST /api/rooms/:id/relay/up        -> push one frame
 *   GET  /api/rooms/:id/relay/down?wait=true -> long-poll the next frame
 *
 * The slot-token returned by /handshake authenticates subsequent up/down
 * calls (in addition to the room secret) so an attacker who only sniffs
 * the secret cannot hijack a live slot.
 *
 * Security and DoS bounds are identical to ws-transport.js. The receive
 * state machine is delegated to window.PayloadAssembler so the two
 * relay transports share one implementation.
 *
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    const FILE_ACK_TIMEOUT_MS = 30_000;
    const CHUNK_SIZE = 16_384; // 16 KiB, matches webrtc.js and ws-transport.js
    // The /relay/down endpoint blocks up to LP_SERVER_HOLD_MS server-side;
    // the client immediately re-polls on timeout. POLL_BACKOFF_MS is the
    // minimum gap between failed polls so a server-side error storm does
    // not turn into a fetch tight loop.
    const POLL_BACKOFF_MS = 1_000;

    class LPTransport {
        constructor() {
            this.tag = 'LP';
            this.roomId = null;
            this.roomSecret = null;

            // Compat with WebSendRTC surface
            this.iceServers = [];
            this.pc = null;

            // Event callbacks (set by caller)
            this.onConnected = null;
            this.onDisconnected = null;
            this.onMessage = null;
            this.onStateChange = null;
            this.onConnectionTypeDetected = null;

            window.PayloadAssembler.initState(this);
            this._fileAckInFlight = false;

            this._connected = false;
            this._closed = false;

            this._slot = null;       // 'a' | 'b'
            this._slotToken = null;
            this._pollAbort = null;  // AbortController for the in-flight poll
            this._helloSent = false;
        }

        async init() { /* no-op; /api/config is fetched by RacingTransport */ }

        setRoom(roomId, secret) {
            this.roomId = roomId;
            this.roomSecret = secret;
        }

        openSlotA() { this._open(); }

        openSlotB(roomId, secret) {
            this.roomId = roomId;
            this.roomSecret = secret;
            this._open();
        }

        async _open() {
            if (this._slotToken || this._closed) return;
            if (!this.roomId || !this.roomSecret) {
                logger.warn('[LP] open called without room/secret');
                return;
            }
            try {
                const res = await fetch(`/api/rooms/${this.roomId}/relay/handshake`, {
                    method: 'POST',
                    headers: {
                        'X-Room-Secret': this.roomSecret,
                        'Content-Type': 'application/json',
                    },
                    body: '{}',
                });
                if (!res.ok) {
                    logger.warn(`[LP] handshake refused: ${res.status}`);
                    this._handleDisconnect('handshake-refused');
                    return;
                }
                const body = await res.json();
                this._slot = body.slot;
                this._slotToken = body.token;
                logger.info(`[LP] handshake ok, slot=${this._slot}`);
            } catch (e) {
                logger.warn('[LP] handshake threw: ' + e.message);
                this._handleDisconnect('handshake-threw');
                return;
            }
            // Send our relay-hello so the peer knows we're live. The peer's
            // hello arrives via the down-poll and triggers _markConnected.
            this._sendControl({ type: 'relay-hello' }).catch((e) => {
                logger.warn('[LP] relay-hello send failed: ' + e.message);
            });
            this._helloSent = true;
            this._pollLoop();
        }

        async _pollLoop() {
            while (!this._closed && this._slotToken) {
                let res;
                try {
                    this._pollAbort = new AbortController();
                    res = await fetch(`/api/rooms/${this.roomId}/relay/down?wait=true`, {
                        method: 'GET',
                        headers: {
                            'X-Room-Secret': this.roomSecret,
                            'X-Slot-Token': this._slotToken,
                        },
                        signal: this._pollAbort.signal,
                    });
                } catch (e) {
                    if (this._closed) return;
                    if (e.name === 'AbortError') return;
                    logger.warn('[LP] poll fetch threw: ' + e.message);
                    await new Promise(r => setTimeout(r, POLL_BACKOFF_MS));
                    continue;
                } finally {
                    this._pollAbort = null;
                }
                if (this._closed) return;

                if (res.status === 204) continue; // long-poll timeout, repoll
                if (res.status === 410) {
                    logger.warn('[LP] slot closed by server');
                    this._handleDisconnect('slot-closed');
                    return;
                }
                if (!res.ok) {
                    logger.warn(`[LP] poll status ${res.status}; backing off`);
                    await new Promise(r => setTimeout(r, POLL_BACKOFF_MS));
                    continue;
                }

                const ct = (res.headers.get('content-type') || '').toLowerCase();
                if (ct.includes('application/octet-stream')) {
                    const buf = await res.arrayBuffer();
                    window.PayloadAssembler.handleBinary(this, buf);
                } else {
                    const text = await res.text();
                    this._handleControlFrame(text);
                }
            }
        }

        _handleControlFrame(text) {
            if (text.length * 2 > window.Protocol.MAX_CONTROL_MSG_BYTES) {
                logger.error(`[LP] dropping oversized control msg (${text.length} chars)`);
                return;
            }
            let msg;
            try { msg = JSON.parse(text); }
            catch (e) { logger.error('[LP] bad JSON: ' + e.message); return; }

            if (msg && msg.type === 'relay-hello') {
                if (!this._connected) this._markConnected();
                return;
            }
            const vr = window.Protocol.validate(msg);
            if (!vr.ok) {
                logger.error('[LP] dropping inbound message: ' + vr.error);
                return;
            }
            logger.info(`[LP] received message type: ${msg.type}`);
            if (!window.PayloadAssembler.handleControl(this, msg)) {
                if (this.onMessage) this.onMessage(msg);
            }
        }

        _markConnected() {
            this._connected = true;
            logger.success('[LP] both peers paired on the relay — connection ready');
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

        _handleDisconnect(_reason) {
            if (this._closed) return;
            this._connected = false;
            if (this.onStateChange) this.onStateChange('failed');
            if (this.onDisconnected) this.onDisconnected();
        }

        _abortTransport(_reason) {
            // Best-effort: tell the server we're done so the peer is closed
            // immediately instead of waiting for the LP idle timeout.
            this._sendClose().catch(() => {});
        }

        async _sendControl(obj) {
            const body = JSON.stringify(obj);
            // Sent as text/plain (not application/json) so the global
            // express.json() body parser leaves it for our route-level
            // express.raw() to read as bytes. The peer parses it as JSON
            // on the receive side identically to a WS text frame.
            const res = await fetch(`/api/rooms/${this.roomId}/relay/up`, {
                method: 'POST',
                headers: {
                    'X-Room-Secret': this.roomSecret,
                    'X-Slot-Token': this._slotToken,
                    'Content-Type': 'text/plain',
                },
                body,
            });
            if (!res.ok) throw new Error(`up status ${res.status}`);
        }

        async _sendBinary(chunk) {
            const res = await fetch(`/api/rooms/${this.roomId}/relay/up`, {
                method: 'POST',
                headers: {
                    'X-Room-Secret': this.roomSecret,
                    'X-Slot-Token': this._slotToken,
                    'Content-Type': 'application/octet-stream',
                },
                body: chunk,
            });
            if (!res.ok) throw new Error(`up status ${res.status}`);
        }

        async _sendClose() {
            if (!this._slotToken) return;
            try {
                await fetch(`/api/rooms/${this.roomId}/relay/close`, {
                    method: 'POST',
                    headers: {
                        'X-Room-Secret': this.roomSecret,
                        'X-Slot-Token': this._slotToken,
                    },
                });
            } catch (_) {}
        }

        sendMessage(message) {
            if (!this._connected) {
                logger.error('[LP] not connected, cannot send message');
                return false;
            }
            const vr = window.Protocol.validate(message);
            if (!vr.ok) {
                logger.error('[LP] refusing to send invalid message: ' + vr.error);
                return false;
            }
            // Fire-and-forget; failures surface via the poll loop's
            // disconnect handling.
            this._sendControl(message).catch((e) => {
                logger.warn('[LP] sendMessage failed: ' + e.message);
            });
            return true;
        }

        async sendFile(encryptedData, onProgress) {
            if (!this._connected) {
                logger.error('[LP] not connected, cannot send file');
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
                    throw new Error('Failed to send file-start (LP not connected)');
                }
                logger.info(`[LP] sending encrypted file (${totalSize} bytes, padded)`);
                while (offset < totalSize) {
                    if (this._closed) throw new Error('LP closed mid-transfer');
                    const chunk = encryptedData.slice(offset, offset + CHUNK_SIZE);
                    // Sequential awaits provide natural backpressure: the
                    // server only acks our POST when the queue accepts the
                    // frame, and an LP slot has a bounded queue. No need
                    // for an explicit highWater check.
                    await this._sendBinary(chunk);
                    offset += chunk.byteLength;
                    const percent = Math.round((offset / totalSize) * 100);
                    if (onProgress) onProgress(percent, offset, totalSize);
                }
                if (!this.sendMessage(window.Protocol.build.fileEnd())) {
                    throw new Error('Failed to send file-end');
                }
                logger.info('[LP] all chunks sent, waiting for receiver acknowledgment...');
                return await new Promise((resolve, reject) => {
                    window.PayloadAssembler.setupFileAck(this, resolve, reject, FILE_ACK_TIMEOUT_MS);
                });
            } finally {
                this._fileAckInFlight = false;
            }
        }

        isConnected() { return this._connected; }

        close() {
            this._closed = true;
            if (this._fileAckReject) {
                window.PayloadAssembler.rejectFileAck(this, new Error(
                    'Connection closed before receiver acknowledged transfer'));
            }
            if (this._pollAbort) { try { this._pollAbort.abort(); } catch (_) {} this._pollAbort = null; }
            this._sendClose().catch(() => {});
            window.PayloadAssembler.resetReceive(this);
            this._connected = false;
        }
    }

    window.LPTransport = LPTransport;
})();
