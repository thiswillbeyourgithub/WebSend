/**
 * sender-connect.js
 *
 * Owns the sender's connection lifecycle: room join, WebRTC state
 * callbacks, ECDH key exchange, fingerprint verification handshake,
 * reconnect-after-disconnect, and the inbound message dispatcher.
 *
 * Extracted from send.html as part of the modular refactor.
 *
 * Exposed as window.SenderConnect.
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    // -- Connection state --
    let rtc = null;
    let keyPair = null;
    let sharedKey = null;
    let weConfirmed = false;
    let theyConfirmed = false;
    let lastRoomId = null;
    let lastSecret = null;
    // True when a 'ready' arrived before local verification state caught
    // up (e.g. control messages reordered across a transport switch, or
    // the user clicked Match a fraction of a second later than the
    // receiver). Re-evaluated after weConfirmed / theyConfirmed flip
    // so a dropped ready does not wedge the sender permanently.
    let pendingReady = false;
    // Fingerprints cached after the original verification so we can
    // recognise the SAME peer after a transport reconnect and skip the
    // verification modal. A mismatch on reconnect = peer swap / MITM
    // attempt; we force a fresh pairing in that case.
    let cachedTheirFingerprint = null;
    let cachedOurFingerprint = null;
    // True between the transport firing onTransientDisconnect and the
    // first successful re-handshake after onReconnected. handlePublicKey
    // accepts a re-key in this window and validates it against the
    // cached fingerprints.
    let inReconnect = false;

    // -- Wired-in deps --
    let _i18n = null;
    let _logger = null;
    let _showToast = null;
    let _onReadyToCapture = null;
    let _onFingerprintReady = null;
    let _onShowConnecting = null;
    let _onScanRequested = null;

    function attach(deps) {
        _i18n = deps.i18n;
        _logger = deps.logger;
        _showToast = deps.showToast;
        _onReadyToCapture = deps.onReadyToCapture;
        _onFingerprintReady = deps.onFingerprintReady;
        _onShowConnecting = deps.onShowConnecting;
        _onScanRequested = deps.onScanRequested;
    }

    // ============ Room Joining ============

    async function join(roomId, secret) {
        // If we're switching to a different roomId (i.e. a brand-new pairing,
        // not a same-room reconnect), shred any in-memory user data first.
        // Confirm with the user only when the gallery is non-empty so we don't
        // silently drop unsent or recently sent photos.
        if (lastRoomId && lastRoomId !== roomId) {
            if (window.Gallery && window.Gallery.size() > 0) {
                const msg = _i18n.t('send.confirmShredOnNewPairing');
                if (!confirm(msg)) {
                    _logger.info('User declined new pairing; staying on current room');
                    if (_onScanRequested) _onScanRequested();
                    return;
                }
            }
            _logger.info('Switching to new pairing — shredding local state');
            if (window.Gallery && typeof window.Gallery.shredLocal === 'function') {
                window.Gallery.shredLocal();
            }
            if (window.SenderSend && typeof window.SenderSend.clear === 'function') {
                window.SenderSend.clear();
            }
            keyPair = null;
            sharedKey = null;
            weConfirmed = false;
            theyConfirmed = false;
            pendingReady = false;
            cachedTheirFingerprint = null;
            cachedOurFingerprint = null;
            inReconnect = false;
            if (rtc) {
                try { rtc.close(); } catch (_) {}
                rtc = null;
            }
        }

        lastRoomId = roomId;
        lastSecret = secret;
        const statusEl = document.getElementById('connection-status');
        statusEl.textContent = _i18n.t('send.connecting');
        statusEl.className = 'status status-info';

        if (!rtc) {
            keyPair = await window.WebSendCrypto.generateKeyPair();
            rtc = window.Transport.createForSender();
            await rtc.init();
            wireRtcCallbacks();
        }

        try {
            await rtc.joinRoom(roomId, secret);
        } catch (e) {
            _logger.error('Failed to join room: ' + e.message);
            statusEl.textContent = _i18n.t('send.failed') + ': ' + e.message;
            statusEl.className = 'status status-error';
            setTimeout(() => { if (_onScanRequested) _onScanRequested(); }, 3000);
        }
    }

    function wireRtcCallbacks() {
        rtc.onConnected = onConnected;
        rtc.onDisconnected = onDisconnected;
        rtc.onMessage = onMessage;
        rtc.onStateChange = onStateChange;
        rtc.onConnectionTypeDetected = window.PeerUI.onConnectionTypeDetected;
        rtc.onReconnecting = onReconnecting;
        rtc.onReconnected = onReconnected;
    }

    // ============ WebRTC state callbacks ============

    function onStateChange(state) {
        const statusEl = document.getElementById('connection-status');
        if (state === 'connecting') {
            statusEl.textContent = _i18n.t('send.establishing');
            statusEl.className = 'status status-info';
        } else if (state === 'connected') {
            statusEl.textContent = _i18n.t('send.connected');
            statusEl.className = 'status status-connected';
        } else if (state === 'failed') {
            let detail = _i18n.t('send.failed');
            if (!window.PeerUI.hasTurn(rtc.iceServers)) {
                detail += '\n' + _i18n.t('send.failedNoTurn');
            }
            statusEl.textContent = detail;
            statusEl.className = 'status status-error';
            statusEl.classList.add('status-pre-line');
            if (!document.getElementById('error-retry-btn')) {
                const retryBtn = document.createElement('button');
                retryBtn.id = 'error-retry-btn';
                retryBtn.textContent = _i18n.t('send.backToScan') || 'Back to scan';
                retryBtn.className = 'btn btn-action retry-btn';
                retryBtn.addEventListener('click', () => {
                    retryBtn.remove();
                    if (_onScanRequested) _onScanRequested();
                });
                document.getElementById('step-connecting').appendChild(retryBtn);
            }
            if (_onShowConnecting) _onShowConnecting();
        }
    }

    async function onConnected() {
        _logger.success('Connected to receiver!');
        window.wakeLockMgr.desired = true;
        await window.wakeLockMgr.acquire();
    }

    function onDisconnected() {
        _logger.warn('Disconnected from receiver');
        window.wakeLockMgr.release();
        _showToast(_i18n.t('send.disconnectedHint'), { duration: 0 });
    }

    // RacingTransport callbacks for the auto-reconnect path. The transport
    // itself owns the retry-forever loop; sender-connect just surfaces the
    // status to the UI and arms the rekey-on-reconnect branch.
    function onReconnecting(attempt) {
        inReconnect = true;
        _logger.warn(`Relay reconnect attempt ${attempt}`);
        const statusEl = document.getElementById('connection-status');
        if (statusEl) {
            statusEl.textContent = (_i18n.t('send.reconnecting') || 'Reconnecting...') +
                (attempt > 1 ? ` (${attempt})` : '');
            statusEl.className = 'status status-info';
        }
    }

    function onReconnected() {
        _logger.success('Relay reconnected; awaiting peer re-handshake');
        const statusEl = document.getElementById('connection-status');
        if (statusEl) {
            statusEl.textContent = _i18n.t('send.connected');
            statusEl.className = 'status status-connected';
        }
        // inReconnect stays true until handlePublicKey verifies the
        // peer's fingerprint matches the cached one.
    }

    // ============ Reconnect ============

    async function reconnect() {
        if (!lastRoomId || !lastSecret) {
            _logger.warn('reconnect() called with no stored room — ignoring');
            return;
        }
        _logger.info('Reconnecting sender...');
        _showToast(_i18n.t('send.reconnecting'), { duration: 3000 });

        // Close existing connection (commit c73d204 invariant)
        if (rtc) {
            try { rtc.close(); } catch (_) {}
        }

        // Reset crypto and queue state
        keyPair = await window.WebSendCrypto.generateKeyPair();
        sharedKey = null;
        weConfirmed = false;
        theyConfirmed = false;
        pendingReady = false;
        cachedTheirFingerprint = null;
        cachedOurFingerprint = null;
        inReconnect = false;
        window.SenderSend.clear();

        rtc = window.Transport.createForSender();
        await rtc.init();
        wireRtcCallbacks();

        await join(lastRoomId, lastSecret);
    }

    // ============ Key exchange + fingerprint verification ============

    async function handlePublicKey(msg) {
        // Reconnect branch: a public-key arriving with sharedKey already
        // set is allowed only when the RacingTransport announced a
        // reconnect. We verify the peer's fingerprint hasn't changed
        // (preserving the original anti-MITM gate), keep the existing
        // sharedKey + weConfirmed/theyConfirmed state, and just answer
        // with our public-key so the receiver can do its own check.
        if (sharedKey) {
            if (!inReconnect) {
                // Same refusal as before: a mid-session re-key without a
                // reconnect signal would silently rotate the encryption
                // key under fingerprint state the user has already
                // confirmed.
                _logger.warn('Ignoring unexpected public-key after key exchange already completed');
                _showToast(_i18n.t('send.unexpectedRekey') || 'Unexpected re-key attempt blocked', { type: 'error', duration: 5000 });
                return;
            }
            try {
                const receiverPublicKey = await window.WebSendCrypto.importPublicKey(msg.key);
                const newTheirFingerprint = await window.WebSendCrypto.getKeyFingerprint(receiverPublicKey);
                if (newTheirFingerprint !== cachedTheirFingerprint) {
                    // The peer changed during the reconnect window. Could
                    // be a peer-swap MITM. Refuse to silently auto-confirm
                    // and force the user back to scan so they see a fresh
                    // verification ceremony.
                    _logger.error(`Peer fingerprint changed during reconnect: cached ${cachedTheirFingerprint} vs new ${newTheirFingerprint}`);
                    _showToast(_i18n.t('send.peerChangedOnReconnect') ||
                        'Peer key changed during reconnect, please rescan', { type: 'error', duration: 0 });
                    sharedKey = null;
                    weConfirmed = false;
                    theyConfirmed = false;
                    cachedTheirFingerprint = null;
                    cachedOurFingerprint = null;
                    inReconnect = false;
                    if (_onScanRequested) _onScanRequested();
                    return;
                }
                // Same peer. Re-send our public-key so the receiver can
                // do its own fingerprint comparison. Crypto state is
                // preserved verbatim so the in-flight encrypted file is
                // still decryptable.
                const ourPublicKeyB64 = await window.WebSendCrypto.exportPublicKey(keyPair.publicKey);
                rtc.sendMessage(window.Protocol.build.senderPublicKey(ourPublicKeyB64));
                _logger.success(`Reconnect rekey verified, peer fingerprint unchanged (${newTheirFingerprint})`);
                inReconnect = false;
                // weConfirmed / theyConfirmed are kept from the original
                // session so the sender stays past the verification gate.
            } catch (e) {
                _logger.error('Failed to verify peer on reconnect: ' + e.message);
            }
            return;
        }
        _logger.info('Received receiver public key, performing key exchange...');
        try {
            const receiverPublicKey = await window.WebSendCrypto.importPublicKey(msg.key);
            sharedKey = await window.WebSendCrypto.deriveSharedKey(keyPair.privateKey, receiverPublicKey);

            const ourFingerprint = await window.WebSendCrypto.getKeyFingerprint(keyPair.publicKey);
            const theirFingerprint = await window.WebSendCrypto.getKeyFingerprint(receiverPublicKey);
            cachedOurFingerprint = ourFingerprint;
            cachedTheirFingerprint = theirFingerprint;

            _logger.success(`Key exchange complete. Our key: ${ourFingerprint}, Their key: ${theirFingerprint}`);

            const ourPublicKeyB64 = await window.WebSendCrypto.exportPublicKey(keyPair.publicKey);
            rtc.sendMessage(window.Protocol.build.senderPublicKey(ourPublicKeyB64));
            _logger.info('Sent our public key to receiver');

            if (_onFingerprintReady) {
                _onFingerprintReady(theirFingerprint, ourFingerprint);
            }
        } catch (e) {
            _logger.error('Failed to complete key exchange: ' + e.message);
        }
    }

    function handleFingerprintConfirmed() {
        _logger.info('Receiver confirmed fingerprint match');
        theyConfirmed = true;
        if (pendingReady) maybeFlushReady();
    }

    function handleFingerprintDenied() {
        _logger.error('Receiver denied fingerprint match - possible MITM attack!');
        _showToast(_i18n.t('verify.deniedByReceiver'), { duration: 5000 });
    }

    function handleReady() {
        // Defense in depth: a malicious receiver can send `ready` without
        // ever sending `fingerprint-confirmed` (or before the user has
        // clicked "match" locally), trying to fast-forward the sender UI
        // past verification and into capture mode. Only honour `ready`
        // when BOTH sides have explicitly confirmed and a shared key was
        // actually derived.
        if (!sharedKey || !weConfirmed || !theyConfirmed) {
            _logger.warn(`Deferring 'ready' until verification completes (sharedKey=${!!sharedKey}, weConfirmed=${weConfirmed}, theyConfirmed=${theyConfirmed})`);
            // Defer rather than drop: confirmFingerprint /
            // handleFingerprintConfirmed will re-trigger maybeFlushReady
            // once the local flags catch up. The security check still
            // gates capture mode (capture only opens when all three
            // conditions are simultaneously true), so deferring is safe.
            pendingReady = true;
            return;
        }
        pendingReady = false;
        _logger.success('Both parties verified, can now send photos');
        window.PeerUI.showVerifiedInSidebar();
        if (_onReadyToCapture) _onReadyToCapture();
    }

    function maybeFlushReady() {
        if (!pendingReady) return;
        if (!sharedKey || !weConfirmed || !theyConfirmed) return;
        _logger.info('Verification state caught up; honoring previously-deferred ready');
        handleReady();
    }

    // Per-photo cap on transform-nack-driven re-sends. A verified-but-
    // hostile receiver could otherwise spam transform-nack for the same
    // oldHash and drive the sender into infinite re-encrypt/re-send
    // loops (the plaintext hash, and therefore photo.sentHash, doesn't
    // change between sends). 2 is enough for a legitimate retry plus
    // a one-off transient failure.
    const MAX_NACK_RETRIES_PER_PHOTO = 2;

    function handleTransformNack(msg) {
        const reason = msg.reason || 'unknown';
        _logger.warn(`transform-nack received for ${msg.oldHash?.substring(0, 8)}... (${reason})`);

        const photo = window.Gallery.photos().find(p => p && p.sentHash === msg.oldHash);
        if (!photo) {
            _logger.warn('transform-nack: no local photo matches oldHash, cannot recover');
            _showToast(_i18n.t('send.transformFailedUnknown'), { type: 'error' });
            return;
        }

        // Cap re-sends per photo so a hostile peer cannot pin the queue.
        photo.nackRetries = (photo.nackRetries || 0) + 1;
        if (photo.nackRetries > MAX_NACK_RETRIES_PER_PHOTO) {
            _logger.error(`transform-nack: refusing to re-send photo ${msg.oldHash?.substring(0, 8)} more than ${MAX_NACK_RETRIES_PER_PHOTO} times`);
            _showToast(_i18n.t('send.transformFailedUnknown'), { type: 'error' });
            return;
        }

        photo.transforms = [];
        photo.sendStatus = 'queuing';

        window.SenderSend.push({ blob: photo.blob, photoId: photo.id, replaceHash: msg.oldHash });
        _logger.info(`Re-queued photo for replace-image fallback (${window.SenderSend.size()} in queue)`);
        _showToast(_i18n.t('send.transformRetrying'), { type: 'warn' });
        window.SenderSend.drain();
    }

    const messageHandlers = {
        'public-key': handlePublicKey,
        'fingerprint-confirmed': handleFingerprintConfirmed,
        'fingerprint-denied': handleFingerprintDenied,
        'ready': handleReady,
        'transform-nack': handleTransformNack,
        // Relay-reconnect resume: receiver tells us what bytes of an
        // in-flight file-start it still holds. SenderSend looks up the
        // matching cached encryptedData and either resumes from the
        // offset or restarts the transfer.
        'file-resume-offer': (msg) => window.SenderSend.handleResumeOffer(msg),
    };

    async function onMessage(msg) {
        const handler = messageHandlers[msg.type];
        if (!handler) {
            _logger.warn(`Unknown message type: ${msg.type}`);
            return;
        }
        await handler(msg);
    }

    // ============ Fingerprint user actions ============

    async function sendMessageWithRetry(message, label) {
        const delaysMs = [0, 50, 150, 300, 600, 1200];
        for (const d of delaysMs) {
            if (d > 0) await new Promise(r => setTimeout(r, d));
            if (rtc.sendMessage(message)) {
                if (d > 0) _logger.info(`Sent ${label} after ${d}ms retry`);
                return true;
            }
        }
        _logger.error(`Failed to send ${label} after retries - peer will not advance`);
        return false;
    }

    async function confirmFingerprint() {
        weConfirmed = true;
        await sendMessageWithRetry(window.Protocol.build.fingerprintConfirmed(), 'fingerprint-confirmed');
        // Honour a 'ready' that arrived before the user clicked Match.
        if (pendingReady) maybeFlushReady();
    }

    async function denyFingerprint() {
        await sendMessageWithRetry(window.Protocol.build.fingerprintDenied(), 'fingerprint-denied');
    }

    // ============ Cleanup ============

    function cleanup() {
        if (rtc) {
            rtc.receiveBuffer = [];
            try { rtc.close(); } catch (_) {}
        }
        rtc = null;
        keyPair = null;
        sharedKey = null;
        weConfirmed = false;
        theyConfirmed = false;
        pendingReady = false;
        cachedTheirFingerprint = null;
        cachedOurFingerprint = null;
        inReconnect = false;
        lastRoomId = null;
        lastSecret = null;
        if (window.Gallery && typeof window.Gallery.shredLocal === 'function') {
            try { window.Gallery.shredLocal(); } catch (_) {}
        }
        if (window.wakeLockMgr && typeof window.wakeLockMgr.release === 'function') {
            try { window.wakeLockMgr.release(); } catch (_) {}
        }
    }

    /** Pre-room initialization so getRtc()/getSharedKey() are stable. */
    async function init() {
        keyPair = await window.WebSendCrypto.generateKeyPair();
        rtc = window.Transport.createForSender();
        await rtc.init();
        wireRtcCallbacks();
    }

    // Frozen so a hostile script cannot swap isVerified / getSharedKey
    // / confirmFingerprint to bypass the verification gate from outside.
    window.SenderConnect = Object.freeze({
        attach,
        init,
        join,
        reconnect,
        confirmFingerprint,
        denyFingerprint,
        cleanup,
        getRtc: () => rtc,
        getSharedKey: () => sharedKey,
        // True only when key exchange completed AND both sides confirmed
        // the fingerprint. Callers on the send path must consult this
        // before encrypting/transmitting a photo, so a future code change
        // that advances UI without verification cannot leak user data.
        isVerified: () => !!sharedKey && weConfirmed && theyConfirmed,
        // For visibilitychange, quick state probe without exposing internals
        connectionLost: () => rtc && rtc.pc && (rtc.pc.connectionState === 'failed' || rtc.pc.connectionState === 'disconnected'),
    });
})();
