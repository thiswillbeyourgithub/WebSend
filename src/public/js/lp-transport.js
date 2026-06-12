/**
 * lp-transport.js, long-poll HTTP-relay fallback transport.
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
    // LP uses larger chunks than WS/WebRTC because every chunk is a full
    // HTTP round-trip; 300 KiB keeps a 10 MB transfer at ~35 POSTs instead
    // of 640. Must stay under the server's LP_FRAME_BODY_LIMIT (320 KiB)
    // with headroom.
    const CHUNK_SIZE = 300 * 1024; // 300 KiB
    // The /relay/down endpoint blocks up to LP_SERVER_HOLD_MS server-side;
    // the client immediately re-polls on timeout. POLL_BACKOFF_MS is the
    // minimum gap between failed polls so a server-side error storm does
    // not turn into a fetch tight loop.
    const POLL_BACKOFF_MS = 1_000;
    // Voluntary client-side pacing on /relay/up. The server no longer
    // rate-limits the data path (see server.js commit), but a corporate
    // proxy in front of the server might. 50 ms = 20 req/sec which
    // still sits below typical proxy thresholds while pushing
    // ~6 MB/sec at CHUNK_SIZE=300 KiB (a 4 GiB file in ~12 min rather
    // than ~28, comfortably inside the activity-refreshed room TTL).
    const LP_UP_MIN_GAP_MS = 50;
    // /relay/up answers 429 when the peer's queue is full (server-side
    // backpressure, replacing the old silent frame drop that corrupted
    // transfers). The queue drains one frame per receiver round trip
    // (~100-300 ms), so retry the same frame on a short fixed gap; a 429
    // from an upstream proxy carries Retry-After and is honoured instead.
    // Give up after UP_STALL_MAX_MS of solid 429s: the peer is alive
    // (otherwise the slot would close with 410) but not draining, e.g. a
    // suspended background tab.
    const UP_RETRY_GAP_MS = 250;
    const UP_STALL_MAX_MS = 30_000;

    function sleep(ms) {
        return ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
    }

    function parseRetryAfter(res) {
        const h = res.headers.get('Retry-After');
        if (!h) return 0;
        const n = parseInt(h, 10);
        return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
    }

    // A drop mid-sendFile throws the shared window.TransientDisconnectError
    // (defined in segment-stream.js) so SenderSend can pause for resume.

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
            this.onTransientDisconnect = null;
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
            // Last /relay/up POST timestamp for client-side pacing.
            this._lastUpAt = 0;
            // Peer backlog (bytes accepted by the server but not yet
            // drained by the peer), from the X-Peer-Backlog-Bytes header
            // of the last successful /relay/up. Used by sendFile to show
            // delivered progress instead of uploaded progress.
            this._peerBacklogBytes = 0;
            // FIFO chain for ALL /relay/up POSTs (control and binary
            // alike). sendMessage is fire-and-forget, so without this an
            // unawaited control frame could overtake or trail the binary
            // records around it; in-band ordering is what guarantees
            // file-start, segment-rewind and file-resume-ack reach the
            // receiver strictly before the records that depend on them.
            this._upQueue = Promise.resolve();
        }

        _enqueueUp(fn) {
            const run = this._upQueue.then(fn);
            // Keep the chain alive whatever fn does; the error still
            // propagates to this caller through `run`.
            this._upQueue = run.then(() => {}, () => {});
            return run;
        }

        async _paceUp() {
            const now = Date.now();
            const gap = LP_UP_MIN_GAP_MS - (now - this._lastUpAt);
            if (gap > 0) await sleep(gap);
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

        /**
         * Re-open the LP slot after a transient drop. The room id /
         * secret are kept; we just need to re-claim a slot from the
         * server. PayloadAssembler state is preserved so byte-level
         * resume can replay the file from the receiver's last byte.
         */
        reopen() {
            if (this._closed) return;
            if (this._slotToken) return;
            this._open();
        }

        async _open() {
            if (this._slotToken || this._closed) return;
            if (!this.roomId || !this.roomSecret) {
                logger.warn('[LP] open called without room/secret');
                return;
            }
            // Retry the handshake forever with bounded backoff. The
            // RacingTransport's reconnect loop also drives reopen()
            // attempts, but a single _open() call is allowed to outlive
            // a brief 503 / 409 burst so a successful retry within the
            // same call avoids re-entering RacingTransport.
            const backoffSchedule = [0, 500, 1_000, 2_000, 5_000];
            let attempt = 0;
            while (!this._closed && !this._slotToken) {
                const wait = backoffSchedule[Math.min(attempt, backoffSchedule.length - 1)];
                if (wait > 0) await sleep(wait);
                if (this._closed) return;
                try {
                    const res = await fetch(`/api/rooms/${this.roomId}/relay/handshake`, {
                        method: 'POST',
                        headers: {
                            'X-Room-Secret': this.roomSecret,
                            'Content-Type': 'application/json',
                        },
                        body: '{}',
                    });
                    if (res.ok) {
                        const body = await res.json();
                        this._slot = body.slot;
                        this._slotToken = body.token;
                        logger.info(`[LP] handshake ok, slot=${this._slot}` + (attempt > 0 ? ` (after ${attempt} retries)` : ''));
                        break;
                    }
                    // 409 = slots full, 503 = overloaded. Both are transient
                    // and the RacingTransport's higher-level loop will
                    // eventually give up if the room is genuinely gone.
                    // A 401 / 404 is fatal (bad secret / room expired).
                    if (res.status === 401 || res.status === 403 || res.status === 404) {
                        logger.warn(`[LP] handshake fatal: ${res.status}`);
                        this._handleDisconnect('handshake-fatal');
                        return;
                    }
                    // 429 carries a Retry-After hint from an upstream proxy
                    // (the relay endpoints are no longer per-IP rate-limited
                    // by us). Honour it before the next attempt so we don't
                    // re-hammer a saturated bucket.
                    if (res.status === 429) {
                        const ra = parseRetryAfter(res);
                        if (ra > 0) {
                            logger.warn(`[LP] handshake 429, waiting ${ra}ms (Retry-After)`);
                            await sleep(ra);
                        }
                    }
                    logger.warn(`[LP] handshake transient ${res.status}; retrying`);
                } catch (e) {
                    if (this._closed) return;
                    logger.warn('[LP] handshake threw: ' + e.message + '; retrying');
                }
                attempt++;
            }
            if (this._closed || !this._slotToken) return;
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
                    // The server told us the slot is closed. Most often
                    // this means the peer dropped (proxy hiccup, etc) and
                    // the relay-side grace window expired before they
                    // re-handshook. Post-connect this is transient and
                    // the racer reconnects via reopen(); pre-connect (no
                    // relay-hello yet) it has to surface as a hard
                    // disconnect so the racer can stop spinning, since
                    // LP is already the last-resort transport.
                    logger.warn('[LP] slot closed by server; will reconnect');
                    const hadConnected = this._connected;
                    this._slotToken = null;
                    this._slot = null;
                    this._helloSent = false;
                    this._connected = false;
                    if (hadConnected && this.onTransientDisconnect) this.onTransientDisconnect();
                    else this._handleDisconnect('slot-closed');
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
                if (!this._connected) {
                    // Echo back: the peer that opened its slot first
                    // sent its hello while we were absent and the server
                    // dropped it on the floor (no peer yet). Without
                    // this echo, only the second-to-join peer ever marks
                    // connected. The !_connected guard prevents ping-pong.
                    this._sendControl({ type: 'relay-hello' }).catch(() => {});
                    this._markConnected();
                }
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
            logger.success('[LP] both peers paired on the relay, connection ready');
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

        _handleDisconnect(reason) {
            if (this._closed) return;
            this._logRelayFailure(reason);
            this._connected = false;
            if (this.onStateChange) this.onStateChange('failed');
            if (this.onDisconnected) this.onDisconnected();
        }

        _logRelayFailure(reason) {
            const proto = location.protocol;
            const url = this.roomId ? `${proto}//${location.host}/api/rooms/${this.roomId}/relay/{up,down}` : '(no room)';
            logger.warn('=== RELAY FAILURE DIAGNOSTICS (LP) ===');
            logger.warn(`  URL: ${url}`);
            logger.warn(`  Slot: ${this._slot || '?'} reason=${reason || '?'}`);
            logger.warn(`  Session bytes received: ${this._sessionTotalBytes}`);
            logger.warn(`  Last record seq expected: ${this._v2Mode ? this._v2NextSeq : '(no transfer)'}`);
        }

        _abortTransport(_reason) {
            // Best-effort: tell the server we're done so the peer is closed
            // immediately instead of waiting for the LP idle timeout.
            this._sendClose().catch(() => {});
        }

        /**
         * POST one frame to /relay/up, retrying the same frame while the
         * server reports the peer's queue full (429). Returns the response
         * for any other status; the caller decides what non-ok means.
         * On success, records the peer backlog reported by the server so
         * sendFile can display delivered (not merely uploaded) progress.
         */
        async _postUp(contentType, body) {
            const deadline = Date.now() + UP_STALL_MAX_MS;
            for (;;) {
                await this._paceUp();
                const res = await fetch(`/api/rooms/${this.roomId}/relay/up`, {
                    method: 'POST',
                    headers: {
                        'X-Room-Secret': this.roomSecret,
                        'X-Slot-Token': this._slotToken,
                        'Content-Type': contentType,
                    },
                    body,
                });
                this._lastUpAt = Date.now();
                if (res.status !== 429) {
                    const backlog = parseInt(res.headers.get('X-Peer-Backlog-Bytes') || '', 10);
                    if (Number.isFinite(backlog) && backlog >= 0) this._peerBacklogBytes = backlog;
                    return res;
                }
                if (this._closed) throw new Error('up aborted: transport closed');
                if (Date.now() >= deadline) {
                    throw new Error(`up stalled: peer not draining (429 for ${UP_STALL_MAX_MS / 1000}s)`);
                }
                // Our server's queue-full 429 clears within a receiver round
                // trip; an upstream proxy's 429 carries a Retry-After worth
                // honouring. parseRetryAfter returns 0 when absent/invalid.
                const ra = parseRetryAfter(res);
                await sleep(ra > UP_RETRY_GAP_MS ? ra : UP_RETRY_GAP_MS);
            }
        }

        async _sendControl(obj) {
            const body = JSON.stringify(obj);
            // Sent as text/plain (not application/json) so the global
            // express.json() body parser leaves it for our route-level
            // express.raw() to read as bytes. The peer parses it as JSON
            // on the receive side identically to a WS text frame.
            const res = await this._enqueueUp(() => this._postUp('text/plain', body));
            if (!res.ok) throw new Error(`up status ${res.status}`);
        }

        async _sendBinary(chunk) {
            const res = await this._enqueueUp(() => this._postUp('application/octet-stream', chunk));
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

        async sendFile(segmentSender, onProgress, resumeFromSeq) {
            if (!this._connected) {
                // Throw (not `return false`): a falsy resolve would let
                // sendOnePhoto run its post-transfer tail (finishHash)
                // and fail the file even though nothing was sent. Same
                // contract as ws-transport.js / webrtc.js.
                logger.error('[LP] not connected, cannot send file');
                const err = new window.TransientDisconnectError(
                    'LP not connected at sendFile start', resumeFromSeq || 0);
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
                    // Report delivered bytes (server-acked minus the peer's
                    // undrained backlog), not uploaded bytes. Raw upload
                    // counts frames the server accepted instantly, which on
                    // a slow receiver read up to a whole queue (8 MiB) and
                    // roughly 2x in rate ahead of the receiver's display.
                    // Mirrors the bufferedAmount correction in webrtc.js /
                    // ws-transport.js. The backlog includes control frames
                    // and is sampled per-POST; pump clamps to >= 0.
                    backlogBytes: () => this._peerBacklogBytes,
                    sendChunk: async (chunk) => {
                        if (this._closed) {
                            throw new window.TransientDisconnectError('LP closed mid-transfer');
                        }
                        // Sequential awaits provide natural backpressure: the
                        // server only acks our POST when the queue accepts the
                        // frame, and an LP slot has a bounded queue. No need
                        // for an explicit highWater check.
                        try {
                            await this._sendBinary(chunk);
                        } catch (e) {
                            // Any /relay/up failure mid-chunk is treated as a
                            // transient drop so SenderSend can resume after
                            // reconnect from this record.
                            throw new window.TransientDisconnectError(
                                `LP _sendBinary failed: ${e.message}`);
                        }
                    },
                    // Receiver verdict: file-ack value, or {segmentNack: seq}.
                    waitForAck: () => new Promise((resolve, reject) => {
                        window.PayloadAssembler.setupFileAck(this, resolve, reject, FILE_ACK_TIMEOUT_MS);
                    }),
                };
                // transfer() owns the record pump, the file-end, and the
                // segment-nack → rewind → resend retry tail. Control frames
                // it emits ride the same FIFO up-queue as the binary
                // records, so a segment-rewind can never be overtaken by
                // the records resent after it.
                return await window.SegmentStream.transfer(segmentSender, io, onProgress, resumeFromSeq);
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
