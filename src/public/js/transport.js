/**
 * transport.js, transport-agnostic abstraction over the peer connection.
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
 *     async init()                      , fetch /api/config, prepare both inners
 *     async createRoom()                , receiver: POST /api/rooms
 *     async createOfferAndStore()       , receiver: store SDP and open WS slot A
 *     async waitForAnswer()             , receiver: long-poll until peer joins
 *     async joinRoom(roomId, secret)    , sender flow + open WS slot B
 *     close()                           , tear down both inners
 *
 *   Data plane
 *     sendMessage(obj) -> boolean       , JSON control message via the winner
 *     async sendFile(segmentSender, onProgress, resumeFromSeq)
 *                                       , v2 records via the winner, awaits ack
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

    // Reconnect backoff schedule (ms). After the winning relay drops we
    // retry forever, with delays growing to 5 s and then holding flat so
    // a long network outage doesn't melt the server while we're hopeful.
    // The cap matches LP's handshake backoff so both reconnect paths
    // converge at the same retry rate.
    const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 5_000];

    // Bound on how many pre-winner inbound messages we buffer per inner.
    // Only control messages flow before a winner is locked (public-key,
    // and at most a fingerprint-confirmed / ready behind it), so this is
    // comfortably above any legitimate need while denying a hostile relay
    // an unbounded queue.
    const MAX_PENDING_MSGS = 16;

    class RacingTransport {
        constructor(role) {
            this._role = role; // 'receiver' or 'sender', informational
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
            // True when the server is in LP-only mode (RELAY_LP_ONLY=true
            // or DEV_FORCE_CONNECTION=RELAY_LP). The WS racer is skipped
            // entirely (server returns 404 on the upgrade) and the LP
            // racer is spawned the moment we have a room id + secret
            // instead of waiting for WS to disconnect first.
            this._lpOnly = false;
            this._raceGraceMs = RACE_GRACE_MS;
            // Latest connection-type info reported by each inner, keyed by
            // inner name. We cache it because the inner fires it from
            // _markConnected immediately after onConnected, while our
            // _lockWinner runs one event loop turn later (setTimeout 0 in
            // the relay grace path) — without the cache the upward call is
            // dropped because this.winner is still null when CT arrives.
            this._pendingCT = { webrtc: null, ws: null, lp: null };
            // Inbound application messages that arrived on an inner BEFORE a
            // winner was locked, keyed by inner name. A control message (the
            // peer's public-key in particular) can arrive the instant an
            // inner connects, one RTT before our own race-grace timer fires;
            // without buffering it was silently dropped and, because the peer
            // sends public-key only once, the ECDH handshake hung forever and
            // the verification modal never appeared. We queue (bounded) and
            // replay these in _lockWinner once an inner wins; the losers'
            // queues are discarded. Same rationale as _pendingCT above.
            this._pendingMsgs = { webrtc: [], ws: [], lp: [] };
            this._roomId = null;
            this._roomSecret = null;
            // Latched once close() runs so a late inner-connect callback
            // doesn't try to fire onConnected on a torn-down transport.
            this._closed = false;

            // Event callbacks, set by the caller after construction.
            this.onConnected = null;
            this.onDisconnected = null;
            this.onMessage = null;
            this.onStateChange = null;
            this.onConnectionTypeDetected = null;
            // Fires every time the winning inner transport drops and we
            // start trying to reconnect. The UI uses this to surface a
            // "Reconnecting..." banner. attempt is 1-indexed.
            this.onReconnecting = null;
            // Fires once per successful reconnect after a transient drop.
            // The receive page hooks this to emit file-resume-offer (if
            // an in-flight transfer was pending) and to re-run the
            // public-key exchange to detect a peer swap.
            this.onReconnected = null;

            // Reconnect-loop state, used after a winner is locked.
            this._reconnecting = false;
            this._reconnectAbort = false;

            this._wireInners();
        }

        _wireInners() {
            this.webrtc.onConnected = () => this._handleInnerConnected('webrtc');
            this.webrtc.onDisconnected = () => this._handleInnerDisconnected('webrtc');
            this.webrtc.onMessage = (m) => this._handleInnerMessage('webrtc', m);
            this.webrtc.onStateChange = (s) => this._handleInnerStateChange('webrtc', s);
            this.webrtc.onConnectionTypeDetected = (t) => this._handleInnerCT('webrtc', t);
            // WebRTC doesn't expose a transient-disconnect signal yet, so
            // its drops are still treated as fatal. Relay-only resume in v1.

            if (this.ws) {
                this.ws.onConnected = () => this._handleInnerConnected('ws');
                this.ws.onDisconnected = () => this._handleInnerDisconnected('ws');
                this.ws.onTransientDisconnect = () => this._handleInnerTransient('ws');
                this.ws.onMessage = (m) => this._handleInnerMessage('ws', m);
                this.ws.onStateChange = (s) => this._handleInnerStateChange('ws', s);
                this.ws.onConnectionTypeDetected = (t) => this._handleInnerCT('ws', t);
            }
        }

        _wireLp() {
            if (!this.lp) return;
            this.lp.onConnected = () => this._handleInnerConnected('lp');
            this.lp.onDisconnected = () => this._handleInnerDisconnected('lp');
            this.lp.onTransientDisconnect = () => this._handleInnerTransient('lp');
            this.lp.onMessage = (m) => this._handleInnerMessage('lp', m);
            this.lp.onStateChange = (s) => this._handleInnerStateChange('lp', s);
            this.lp.onConnectionTypeDetected = (t) => this._handleInnerCT('lp', t);
        }

        // Spawn the LP fallback transport. Called either when WS
        // disconnects before either side wins (proxies stripping the
        // upgrade, etc), or immediately from createRoom/joinRoom when
        // LP-only mode is active and there is no WS to wait on.
        _spawnLp(reason = 'WS disconnected pre-winner') {
            if (this._lpSpawned || this._closed || this.winner) return;
            if (!this._lpEnabled) return;
            if (typeof window.LPTransport !== 'function') return;
            if (!this._roomId || !this._roomSecret) return;
            this._lpSpawned = true;
            logger.info(`[Race] ${reason}; spawning LP transport`);
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
            if (this._closed) return;
            // Post-reconnect callback path: the winner inner came back
            // up after a transient drop. Fire onReconnected upward so
            // the application layer can re-key / emit file-resume-offer.
            if (this.winner === name && this._reconnecting) {
                this._reconnecting = false;
                logger.success(`[Race] ${name.toUpperCase()} reconnected after transient drop`);
                if (this.onStateChange) this.onStateChange('connected');
                if (this.onReconnected) this.onReconnected();
                return;
            }
            if (this.winner) return;
            if (name === 'webrtc') {
                if (this._relayForced) {
                    logger.info('[Race] WebRTC connected but relay forced, ignoring');
                    return;
                }
                // WebRTC always wins immediately when it connects. The
                // grace window only protects WebRTC from being beaten by
                // a fast relay, it doesn't keep WebRTC waiting.
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
                        logger.info(`[Race] WebRTC did not connect within grace window, using ${this._pendingRelay.toUpperCase()} relay`);
                        this._lockWinner(this._pendingRelay);
                    }, this._raceGraceMs);
                } else if (this._pendingRelay !== 'webrtc') {
                    // A second relay finished its hello while we were
                    // waiting on WebRTC. Prefer WS over LP (lower overhead).
                    if (name === 'ws' && this._pendingRelay === 'lp') this._pendingRelay = 'ws';
                }
            }
        }

        // A relay inner reported a transient disconnect: kick off the
        // reconnect loop on that inner. We do not fall back to a
        // different transport here — the original race already decided
        // which path works on this network. Retrying the same kind is
        // both faster and avoids re-doing the WebRTC ICE handshake which
        // we already know doesn't connect.
        _handleInnerTransient(name) {
            if (this._closed) return;
            // Only act when the dropped inner is our winner. A late
            // transient signal from a loser (already closed by lockWinner)
            // is ignored.
            if (this.winner !== name) return;
            if (this._reconnecting) return; // loop already running
            this._reconnecting = true;
            logger.warn(`[Race] ${name.toUpperCase()} dropped (transient); starting reconnect loop`);
            if (this.onStateChange) this.onStateChange('connecting');
            this._reconnectLoop(name);
        }

        async _reconnectLoop(name) {
            let attempt = 0;
            while (!this._closed && !this._reconnectAbort && this._reconnecting && this.winner === name) {
                const wait = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
                attempt++;
                if (this.onReconnecting) {
                    try { this.onReconnecting(attempt); } catch (_) {}
                }
                logger.info(`[Race] reconnect attempt ${attempt} for ${name.toUpperCase()} in ${wait}ms`);
                await new Promise(r => setTimeout(r, wait));
                if (this._closed || this._reconnectAbort || this.winner !== name) return;
                const inner = this._innerByName(name);
                if (!inner || typeof inner.reopen !== 'function') {
                    logger.error(`[Race] inner ${name} cannot reopen; giving up`);
                    this._reconnecting = false;
                    if (this.onDisconnected) this.onDisconnected();
                    return;
                }
                try {
                    inner.reopen();
                } catch (e) {
                    logger.warn(`[Race] reopen threw: ${e.message}`);
                    continue;
                }
                // Give the inner up to (wait * 4) ms to come back. If
                // _handleInnerConnected fires in that window, it flips
                // _reconnecting off and we exit the loop. If not, we
                // retry with the next backoff step.
                const grace = wait * 4;
                const start = Date.now();
                while (this._reconnecting && !this._closed && !this._reconnectAbort
                    && this.winner === name && Date.now() - start < grace) {
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        }

        _handleInnerDisconnected(name) {
            if (this._closed) return;
            if (this.winner === name) {
                // If we're already in a reconnect loop, treat a second
                // disconnect signal from the same inner as noise: the
                // loop's reopen attempts naturally surface disconnects
                // as they fail, and we don't want to fire onDisconnected
                // upward (that would tear down the pairing).
                if (this._reconnecting) return;
                if (this.onDisconnected) this.onDisconnected();
                return;
            }
            // WS failed before winning: try the LP fallback. Common cause
            // is a proxy that silently strips the WebSocket upgrade.
            if (!this.winner && name === 'ws' && !this._lpSpawned) {
                this._spawnLp();
            }
            // LP failed before winning: LP is the last-resort transport
            // (no further fallback exists), so propagate upward so the
            // UI can surface a real error instead of spinning. If WebRTC
            // is still in flight we let it finish; only when both relays
            // are out do we give up here.
            if (!this.winner && name === 'lp') {
                const wsDead = !this.ws || !(this.ws.isConnected && this.ws.isConnected());
                if (wsDead) {
                    logger.warn('[Race] LP failed pre-winner with no other relay live; giving up');
                    if (this.onDisconnected) this.onDisconnected();
                }
            }
            // If WebRTC fails before connecting and a relay is already
            // hello-ready, lock that relay in now instead of waiting out
            // the grace window: the race is already decided.
            if (!this.winner && name === 'webrtc') {
                if (this.ws && this.ws.isConnected && this.ws.isConnected()) {
                    logger.info('[Race] WebRTC failed; WS already ready, switching to HTTPS relay');
                    this._lockWinner('ws');
                } else if (this.lp && this.lp.isConnected && this.lp.isConnected()) {
                    logger.info('[Race] WebRTC failed; LP already ready, switching to HTTPS relay');
                    this._lockWinner('lp');
                }
            }
        }

        _handleInnerMessage(name, msg) {
            if (this._closed) return;
            if (this.winner === name) {
                if (this.onMessage) this.onMessage(msg);
                return;
            }
            if (!this.winner) {
                // No winner locked yet. Buffer this inner's message so it is
                // replayed when (and if) this inner wins. Dropping it here is
                // what caused the silent "no verification modal" hang on a
                // fast relay connect.
                const q = this._pendingMsgs[name];
                if (q && q.length < MAX_PENDING_MSGS) {
                    q.push(msg);
                } else if (q) {
                    logger.warn(`[Race] pre-winner message buffer for ${name.toUpperCase()} full; dropping a message`);
                }
                return;
            }
            // A different inner already won: this is a loser's late message.
            // It was already closed by _lockWinner; drop it.
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
            // Always cache, so _lockWinner can replay it once the race
            // resolves even if CT arrived before we picked a winner.
            this._pendingCT[name] = t;
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
            // Replay any CT that arrived before we locked the winner (relay
            // transports fire CT synchronously right after onConnected, but
            // _lockWinner runs a tick later via setTimeout 0).
            const cachedCT = this._pendingCT[name];
            if (cachedCT && this.onConnectionTypeDetected) {
                this.onConnectionTypeDetected(cachedCT);
            }
            // Replay any inbound messages that arrived on the winning inner
            // before it won (e.g. the peer's public-key on a fast relay
            // connect), in arrival order. Without this the ECDH handshake
            // would hang. Discard every inner's queue afterwards: the losers'
            // buffered messages belong to connections we just closed.
            const pendingMsgs = this._pendingMsgs[name] || [];
            this._pendingMsgs = { webrtc: [], ws: [], lp: [] };
            if (pendingMsgs.length) {
                logger.info(`[Race] replaying ${pendingMsgs.length} buffered ${name.toUpperCase()} message(s) received before winner lock`);
                for (const m of pendingMsgs) {
                    if (this.onMessage) this.onMessage(m);
                }
            }
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
                    this._lpOnly = !!cfg.lpOnly;
                    if (cfg.forceConnection === 'RELAY_HTTPS' || this._lpOnly) {
                        this._relayForced = true;
                        this._raceGraceMs = RACE_GRACE_FORCED_RELAY_MS;
                        if (this._lpOnly) {
                            logger.warn('[Race] LP-only mode active: WebRTC + WS suppressed, only long-poll relay will run');
                        } else {
                            logger.warn('[Race] DEV_FORCE_CONNECTION=RELAY_HTTPS, WebRTC suppressed, relay wins on hello');
                        }
                    }
                }
            } catch (_) { this._relayEnabled = false; }
            this._lpEnabled = this._relayEnabled && (typeof window.LPTransport === 'function');
            if (this._lpOnly) {
                // Skip WS entirely: the server returns 404 on the upgrade
                // in LP-only mode so any attempt would just waste a
                // roundtrip and emit a misleading "connection closed"
                // disconnect signal into the racer state machine.
                if (this.ws) { try { this.ws.close(); } catch (_) {} }
                this.ws = null;
                logger.info('[Race] LP-only: WS racer skipped, LP will be spawned at room setup');
            } else if (this._relayEnabled && this.ws) {
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
            // LP-only: spawn the long-poll racer right away. The normal
            // flow waits for WS to disconnect first; here there is no WS,
            // so LP must start itself to ever reach the relay-hello state.
            if (this._lpOnly) this._spawnLp('LP-only mode');
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
            // LP-only: spawn the long-poll racer right away (mirror of
            // the createRoom path on the receiver side).
            if (this._lpOnly) this._spawnLp('LP-only mode');
            return this.webrtc.joinRoom(roomId, secret);
        }

        sendMessage(message) {
            if (!this.winner) {
                logger.error('[Race] sendMessage before connection established');
                return false;
            }
            return this._innerByName(this.winner).sendMessage(message);
        }

        async sendFile(segmentSender, onProgress, resumeFromSeq) {
            if (!this.winner) throw new Error('Not connected yet');
            // Propagate resumeFromSeq so SenderSend can record-resume an
            // in-flight transfer after a reconnect; all three inners
            // (WebRTC / WS / LP) honour it.
            return this._innerByName(this.winner).sendFile(segmentSender, onProgress, resumeFromSeq);
        }

        close() {
            this._closed = true;
            this._reconnectAbort = true;
            this._reconnecting = false;
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
