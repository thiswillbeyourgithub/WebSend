/**
 * transport.js — transport-agnostic abstraction over the peer connection.
 *
 * The receiver and sender flows talk to a "Transport" instance rather than
 * directly to a WebRTC peer connection. This lets us swap or race multiple
 * underlying transports: WebRTC (preferred, true P2P or TURN-relayed) and
 * a WebSocket fallback that traverses the same /api/* HTTPS surface for
 * corporate networks where TURNS is blocked or stripped.
 *
 * The duck-typed Transport interface mirrors the public surface that
 * webrtc.js (WebSendRTC) has always exposed:
 *
 *   Lifecycle
 *     async init()                       — fetch /api/config, prepare both inners
 *     async createRoom()                 — receiver: POST /api/rooms
 *     async createOfferAndStore()        — receiver: store SDP and open WS slot A
 *     async waitForAnswer()              — receiver: long-poll until peer joins
 *     async joinRoom(roomId, secret)     — sender flow + open WS slot B
 *     close()                            — tear down both inners
 *
 *   Data plane
 *     sendMessage(obj) -> boolean        — JSON control message via the winner
 *     async sendFile(bytes, onProgress)  — chunked binary via the winner, awaits ack
 *
 *   Event callbacks (set by caller)
 *     onConnected, onDisconnected, onStateChange, onMessage,
 *     onConnectionTypeDetected({type, details, localType, remoteType})
 *
 * Race-based selection (Commit 3):
 *   Both inners are opened in parallel from the start. Whichever fires
 *   onConnected first wins, with one wrinkle: WebRTC is preferred for a
 *   RACE_GRACE_MS (10s) window. If WebRTC connects within that window
 *   (or any time before WS connects) WebRTC wins. If WS connects first
 *   and WebRTC has not connected by t=10s after the WS connect, WS wins.
 *   When a winner locks in, the loser is closed and all subsequent
 *   events come from the winner only.
 *
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    // Grace window after the WS reports connected during which we still
    // wait to see whether WebRTC catches up. Per the design doc; sized
    // so a lucky TURN handshake on a cold cache can still win, while a
    // permanently blocked TURN gives up fast enough to surprise no one.
    const RACE_GRACE_MS = 10_000;
    // Effective grace window when the server has forced the relay path
    // via DEV_FORCE_CONNECTION=RELAY_HTTPS. Letting WebRTC even try here
    // just wastes the test's wall clock.
    const RACE_GRACE_FORCED_RELAY_MS = 0;

    class RacingTransport {
        constructor(role) {
            this._role = role; // 'receiver' or 'sender' — informational
            this.webrtc = new window.WebSendRTC();
            // WSTransport / LPTransport are loaded by the same HTML page;
            // if not present (e.g. a unit test that only stubs WebSendRTC)
            // we fall back to WebRTC-only behaviour gracefully.
            this.ws = (typeof window.WSTransport === 'function')
                ? new window.WSTransport()
                : null;
            // LP is spawned on-demand when the WS path fails before either
            // side wins: a proxy that silently drops the upgrade is the
            // common failure mode this transport exists for.
            this.lp = null;

            this.winner = null;
            this._raceTimer = null;
            this._relayEnabled = false;
            this._lpEnabled = false;
            this._lpSpawned = false;
            // True when the server has forced the relay path. Suppresses
            // the WebRTC racer's onConnected so the relay wins immediately
            // even if WebRTC briefly connects over loopback.
            this._relayForced = false;
            this._raceGraceMs = RACE_GRACE_MS;
            // Cached so we can openSlotA / openSlotB on the LP inner when
            // we spawn it after WS already had its turn at room setup.
            this._roomId = null;
            this._roomSecret = null;
            // Latched once close() runs so a late inner-connect callback
            // doesn't try to fire onConnected on a torn-down transport.
            this._closed = false;

            // Event callbacks — set by the caller after construction.
            this.onConnected = null;
            this.onDisconnected = null;
            this.onMessage = null;
            this.onStateChange = null;
            this.onConnectionTypeDetected = null;

            this._wireInners();
        }

        _wireInners() {
            this.webrtc.onConnected = () => this._handleInnerConnected('webrtc');
            this.webrtc.onDisconnected = () => this._handleInnerDisconnected('webrtc');
            this.webrtc.onMessage = (m) => this._handleInnerMessage('webrtc', m);
            this.webrtc.onStateChange = (s) => this._handleInnerStateChange('webrtc', s);
            this.webrtc.onConnectionTypeDetected = (t) => this._handleInnerCT('webrtc', t);

            if (this.ws) {
                this.ws.onConnected = () => this._handleInnerConnected('ws');
                this.ws.onDisconnected = () => this._handleInnerDisconnected('ws');
                this.ws.onMessage = (m) => this._handleInnerMessage('ws', m);
                this.ws.onStateChange = (s) => this._handleInnerStateChange('ws', s);
                this.ws.onConnectionTypeDetected = (t) => this._handleInnerCT('ws', t);
            }
        }

        _wireLp() {
            if (!this.lp) return;
            this.lp.onConnected = () => this._handleInnerConnected('lp');
            this.lp.onDisconnected = () => this._handleInnerDisconnected('lp');
            this.lp.onMessage = (m) => this._handleInnerMessage('lp', m);
            this.lp.onStateChange = (s) => this._handleInnerStateChange('lp', s);
            this.lp.onConnectionTypeDetected = (t) => this._handleInnerCT('lp', t);
        }

        // Spawn the LP fallback transport. Called when WS disconnects
        // before either side wins (proxies stripping the upgrade, etc).
        _spawnLp() {
            if (this._lpSpawned || this._closed || this.winner) return;
            if (!this._lpEnabled) return;
            if (typeof window.LPTransport !== 'function') return;
            if (!this._roomId || !this._roomSecret) return;
            this._lpSpawned = true;
            logger.info('[Race] WS disconnected pre-winner; spawning LP fallback');
            this.lp = new window.LPTransport();
            this._wireLp();
            this.lp.init().then(() => {
                if (this._closed || this.winner) return;
                if (this._role === 'receiver') {
                    this.lp.setRoom(this._roomId, this._roomSecret);
                    this.lp.openSlotA();
                } else {
                    this.lp.openSlotB(this._roomId, this._roomSecret);
                }
            }).catch((e) => logger.warn('[Race] LP init failed: ' + e.message));
        }

        _handleInnerConnected(name) {
            if (this._closed || this.winner) return;
            if (name === 'webrtc') {
                if (this._relayForced) {
                    logger.info('[Race] WebRTC connected but relay forced — ignoring');
                    return;
                }
                // WebRTC always wins immediately when it connects. The
                // grace window only protects WebRTC from being beaten by
                // a fast relay — it doesn't keep WebRTC waiting.
                this._lockWinner('webrtc');
            } else if (name === 'ws' || name === 'lp') {
                // A relay transport reached the relay-hello handshake.
                // Start (or reuse) the grace timer; if WebRTC doesn't
                // connect before it fires, this relay wins.
                if (!this._raceTimer) {
                    logger.info(`[Race] ${name.toUpperCase()} reached relay-hello; giving WebRTC ${this._raceGraceMs}ms grace window`);
                    this._pendingRelay = name;
                    this._raceTimer = setTimeout(() => {
                        if (this._closed || this.winner) return;
                        logger.info(`[Race] WebRTC did not connect within grace window — using ${this._pendingRelay.toUpperCase()} relay`);
                        this._lockWinner(this._pendingRelay);
                    }, this._raceGraceMs);
                } else if (this._pendingRelay !== 'webrtc') {
                    // A second relay finished its hello while we were
                    // waiting on WebRTC. Prefer WS over LP (lower overhead).
                    if (name === 'ws' && this._pendingRelay === 'lp') this._pendingRelay = 'ws';
                }
            }
        }

        _handleInnerDisconnected(name) {
            if (this._closed) return;
            if (this.winner === name) {
                if (this.onDisconnected) this.onDisconnected();
                return;
            }
            // WS failed before winning: try the LP fallback. Common cause
            // is a proxy that silently strips the WebSocket upgrade.
            if (!this.winner && name === 'ws' && !this._lpSpawned) {
                this._spawnLp();
            }
            // If WebRTC fails before connecting and a relay is already
            // hello-ready, lock that relay in now instead of waiting out
            // the grace window: the race is already decided.
            if (!this.winner && name === 'webrtc') {
                if (this.ws && this.ws.isConnected && this.ws.isConnected()) {
                    logger.info('[Race] WebRTC failed; WS already ready — switching to HTTPS relay');
                    this._lockWinner('ws');
                } else if (this.lp && this.lp.isConnected && this.lp.isConnected()) {
                    logger.info('[Race] WebRTC failed; LP already ready — switching to HTTPS relay');
                    this._lockWinner('lp');
                }
            }
        }

        _handleInnerMessage(name, msg) {
            if (this._closed) return;
            if (this.winner === name && this.onMessage) this.onMessage(msg);
        }

        _handleInnerStateChange(name, state) {
            if (this._closed) return;
            // Forward state changes from the winner. Pre-winner, only
            // forward 'connecting' from WebRTC so the existing UI
            // (which reads connecting/connected/failed) keeps its
            // familiar lifecycle while the race is in flight.
            if (this.winner === name) {
                if (this.onStateChange) this.onStateChange(state);
            } else if (!this.winner && name === 'webrtc') {
                if (this.onStateChange) this.onStateChange(state);
            }
        }

        _handleInnerCT(name, t) {
            if (this._closed) return;
            if (this.winner === name && this.onConnectionTypeDetected) {
                this.onConnectionTypeDetected(t);
            }
        }

        _innerByName(name) {
            if (name === 'webrtc') return this.webrtc;
            if (name === 'ws') return this.ws;
            if (name === 'lp') return this.lp;
            return null;
        }

        _lockWinner(name) {
            if (this.winner || this._closed) return;
            this.winner = name;
            if (this._raceTimer) { clearTimeout(this._raceTimer); this._raceTimer = null; }
            // Close the losers so they stop consuming resources (and so
            // any late messages from them cannot leak through any race
            // condition into onMessage).
            for (const other of ['webrtc', 'ws', 'lp']) {
                if (other === name) continue;
                const inner = this._innerByName(other);
                if (inner) { try { inner.close(); } catch (_) {} }
            }
            logger.success(`[Race] Winner: ${name}`);
            if (this.onConnected) this.onConnected();
        }

        async init() {
            await this.webrtc.init();
            // Decide whether to engage the relay racer(s). /api/config has
            // the relayEnabled flag set by the server (RELAY_ENABLE env).
            // webrtc.init() already fetched /api/config; refetch is cheap
            // and avoids a coupling to its internals.
            try {
                const res = await fetch('/api/config');
                if (res.ok) {
                    const cfg = await res.json();
                    this._relayEnabled = !!cfg.relayEnabled;
                    if (cfg.forceConnection === 'RELAY_HTTPS') {
                        this._relayForced = true;
                        this._raceGraceMs = RACE_GRACE_FORCED_RELAY_MS;
                        logger.warn('[Race] DEV_FORCE_CONNECTION=RELAY_HTTPS — WebRTC suppressed, relay wins on hello');
                    }
                }
            } catch (_) { this._relayEnabled = false; }
            this._lpEnabled = this._relayEnabled && (typeof window.LPTransport === 'function');
            if (this._relayEnabled && this.ws) {
                await this.ws.init();
                logger.info('[Race] HTTP-relay fallback transport enabled (WS primary, LP on-demand)');
            } else {
                logger.info('[Race] HTTP-relay fallback transport disabled (RELAY_ENABLE=false on server)');
            }
        }

        async createRoom() {
            const r = await this.webrtc.createRoom();
            this._roomId = r.roomId;
            this._roomSecret = r.secret;
            if (this._relayEnabled && this.ws) this.ws.setRoom(r.roomId, r.secret);
            return r;
        }

        async createOfferAndStore() {
            // Spawn WS slot 'a' in parallel with the SDP storage.
            if (this._relayEnabled && this.ws) {
                try { this.ws.openSlotA(); } catch (e) { logger.warn('[Race] openSlotA failed: ' + e.message); }
            }
            return this.webrtc.createOfferAndStore();
        }

        async waitForAnswer() {
            return this.webrtc.waitForAnswer();
        }

        async joinRoom(roomId, secret) {
            this._roomId = roomId;
            this._roomSecret = secret;
            // Spawn WS slot 'b' in parallel with the WebRTC join sequence.
            if (this._relayEnabled && this.ws) {
                try { this.ws.openSlotB(roomId, secret); } catch (e) { logger.warn('[Race] openSlotB failed: ' + e.message); }
            }
            return this.webrtc.joinRoom(roomId, secret);
        }

        sendMessage(message) {
            if (!this.winner) {
                logger.error('[Race] sendMessage before connection established');
                return false;
            }
            return this._innerByName(this.winner).sendMessage(message);
        }

        async sendFile(bytes, onProgress) {
            if (!this.winner) throw new Error('Not connected yet');
            return this._innerByName(this.winner).sendFile(bytes, onProgress);
        }

        close() {
            this._closed = true;
            if (this._raceTimer) { clearTimeout(this._raceTimer); this._raceTimer = null; }
            try { this.webrtc.close(); } catch (_) {}
            if (this.ws) { try { this.ws.close(); } catch (_) {} }
            if (this.lp) { try { this.lp.close(); } catch (_) {} }
        }

        // ---- Compat properties read by receive.html and sender-connect.js ----
        // These mirror the surface WebSendRTC exposes so the existing
        // call sites do not need to learn a new shape. roomId/secret
        // setters propagate to both inners so the reconnect-with-same-
        // room flow in receive.html keeps working.

        get roomId() { return this.webrtc.roomId; }
        set roomId(v) {
            this.webrtc.roomId = v;
            if (this.ws) this.ws.roomId = v;
            if (this.lp) this.lp.roomId = v;
        }

        get roomSecret() { return this.webrtc.roomSecret; }
        set roomSecret(v) {
            this.webrtc.roomSecret = v;
            if (this.ws) this.ws.roomSecret = v;
            if (this.lp) this.lp.roomSecret = v;
        }

        get pc() { return this.webrtc.pc; }
        get iceServers() { return this.webrtc.iceServers || []; }

        get receiveBuffer() {
            const w = this._innerByName(this.winner);
            return w ? w.receiveBuffer : this.webrtc.receiveBuffer;
        }
        set receiveBuffer(v) {
            this.webrtc.receiveBuffer = v;
            if (this.ws) this.ws.receiveBuffer = v;
            if (this.lp) this.lp.receiveBuffer = v;
        }
    }

    function createForReceiver() {
        return new RacingTransport('receiver');
    }

    function createForSender() {
        return new RacingTransport('sender');
    }

    // Frozen so a hostile script cannot swap the factories with one that
    // returns a tampered transport (e.g. one whose sendMessage silently
    // drops fingerprint-confirmed, or whose isVerified always returns
    // true). Matches the freeze of WebSendCrypto/Protocol/SenderConnect.
    window.Transport = Object.freeze({
        createForReceiver,
        createForSender,
        // Exposed for unit-testing the race state machine.
        RacingTransport,
        RACE_GRACE_MS,
    });
})();
