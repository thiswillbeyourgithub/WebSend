/**
 * sender-connect.js
 *
 * Owns the sender's connection lifecycle: room join, WebRTC state
 * callbacks, ECDH key exchange + encrypted key-confirm (via the shared
 * Pairing module), reconnect-after-disconnect, and the inbound message
 * dispatcher.
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
    // Pairing state machine (window.Pairing) for the current keyPair + QR
    // secret. Owns the session keys and the "bound" flag: session keys
    // are only handed out once the receiver's key-confirm opened, which
    // is the single gate for sending files.
    let pairing = null;
    let pairingKeyPair = null;
    let lastRoomId = null;
    let lastSecret = null;
    // QR secret K from the invite fragment. Never sent to the server and
    // never logged; kept only so a reconnect can re-derive.
    let lastQrSecret = null;
    // True when a 'ready' arrived before our pairing bound (e.g. the
    // receiver's key-confirm and ready overtook our own derivation).
    // Re-evaluated when the pairing binds so a dropped ready does not
    // wedge the sender permanently.
    let pendingReady = false;
    // True between the transport firing onReconnecting and the first
    // public-key after it. A public-key carrying a DIFFERENT receiver key
    // in this window means the peer changed: we refuse it and force a
    // fresh scan instead of silently re-pairing.
    let inReconnect = false;

    // -- Wired-in deps --
    let _i18n = null;
    let _logger = null;
    let _showToast = null;
    let _onReadyToCapture = null;
    let _onPaired = null;
    let _onShowConnecting = null;
    let _onScanRequested = null;

    function attach(deps) {
        _i18n = deps.i18n;
        _logger = deps.logger;
        _showToast = deps.showToast;
        _onReadyToCapture = deps.onReadyToCapture;
        _onPaired = deps.onPaired;
        _onShowConnecting = deps.onShowConnecting;
        _onScanRequested = deps.onScanRequested;
    }

    // ============ Room Joining ============

    function isBound() {
        return !!pairing && pairing.isBound();
    }

    /** (Re)create the Pairing when the keyPair or QR secret changed. */
    function ensurePairing() {
        if (pairing && pairingKeyPair === keyPair) return;
        if (pairing) pairing.reset();
        pairing = window.Pairing.create({
            role: 'sender',
            keyPair,
            qrSecret: lastQrSecret,
            onBound: onPairingBound,
            onFailed: onPairingFailed,
        });
        pairingKeyPair = keyPair;
    }

    function dropPairing() {
        if (pairing) pairing.reset();
        pairing = null;
        pairingKeyPair = null;
    }

    async function join(roomId, secret, qrSecret) {
        if (!window.WebSendCrypto.isQrSecret(qrSecret)) {
            // Callers parse the invite with QrParse, which already refuses
            // links without K; this is the last line of defence.
            _logger.error('Refusing to join: invite has no valid QR secret');
            _showToast(_i18n.t('send.invalidQR.outdatedLink'), { type: 'error', duration: 0 });
            if (_onScanRequested) _onScanRequested();
            return;
        }
        // A different K for the same room means a fresh QR: start over.
        if (lastQrSecret && lastQrSecret !== qrSecret) dropPairing();
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
            dropPairing();
            pendingReady = false;
            inReconnect = false;
            if (rtc) {
                try { rtc.close(); } catch (_) {}
                rtc = null;
            }
        }

        lastRoomId = roomId;
        lastSecret = secret;
        lastQrSecret = qrSecret;
        const statusEl = document.getElementById('connection-status');
        statusEl.textContent = _i18n.t('send.connecting');
        statusEl.className = 'status status-info';

        if (!rtc) {
            keyPair = await window.WebSendCrypto.generateKeyPair();
            rtc = window.Transport.createForSender();
            await rtc.init();
            wireRtcCallbacks();
        }
        ensurePairing();

        try {
            // Only the room secret goes to the server (X-Room-Secret);
            // the QR secret K never leaves this device.
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

    /**
     * Repair the send UI after the connection comes back (state flips
     * to 'connected', a relay onReconnected fires, or a reconnect
     * re-key verifies). Removes the stale "Back to scan" retry button
     * and, when the wizard was dumped onto the connecting step while
     * the session is still verified, returns to the capture/choose
     * step. Without this the page could dead-end on a "Connected"
     * status with only a back-to-scan button after a drop + recovery
     * (classically: connection dropped while the file picker was
     * open). Also flushes anything queued while the transport was down.
     */
    function restoreSendUiAfterRecovery() {
        const retryBtn = document.getElementById('error-retry-btn');
        if (retryBtn) retryBtn.remove();
        if (!isBound()) return;
        const connecting = document.getElementById('step-connecting');
        if (connecting && !connecting.classList.contains('hidden')) {
            _logger.info('Connection recovered while stuck on the connecting step; restoring capture UI');
            if (_onReadyToCapture) _onReadyToCapture();
        }
        if (window.SenderSend && window.SenderSend.size() > 0 && !window.SenderSend.isActive()) {
            window.SenderSend.drain();
        }
    }

    function onStateChange(state) {
        const statusEl = document.getElementById('connection-status');
        if (state === 'connecting') {
            statusEl.textContent = _i18n.t('send.establishing');
            statusEl.className = 'status status-info';
        } else if (state === 'connected') {
            statusEl.textContent = _i18n.t('send.connected');
            statusEl.className = 'status status-connected';
            restoreSendUiAfterRecovery();
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
                retryBtn.textContent = _i18n.t('send.backToScan');
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
            statusEl.textContent = _i18n.t('send.reconnecting') +
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
        // inReconnect stays true until handlePublicKey sees the
        // receiver's public key again and checks it is unchanged.
        restoreSendUiAfterRecovery();
    }

    // ============ Reconnect ============

    async function reconnect() {
        if (!lastRoomId || !lastSecret || !lastQrSecret) {
            _logger.warn('reconnect() called with no stored room — ignoring');
            return;
        }
        _logger.info('Reconnecting sender...');
        _showToast(_i18n.t('send.reconnecting'), { duration: 3000 });

        // Close existing connection (commit c73d204 invariant)
        if (rtc) {
            try { rtc.close(); } catch (_) {}
        }

        // Reset crypto state. The send queue is NOT cleared: files the
        // user picked while the transport was down must survive the
        // re-pairing. Only their session-bound state (SegmentSenders
        // keyed with the old sessionKeys) is dropped; drain() stays
        // paused until the new session is verified.
        keyPair = await window.WebSendCrypto.generateKeyPair();
        dropPairing();
        pendingReady = false;
        inReconnect = false;
        window.SenderSend.resetForReconnect();

        rtc = window.Transport.createForSender();
        await rtc.init();
        wireRtcCallbacks();

        await join(lastRoomId, lastSecret, lastQrSecret);
    }

    // ============ Key exchange + key-confirm ============

    async function handlePublicKey(msg) {
        if (!pairing) {
            _logger.warn('public-key received before a room was joined; ignoring');
            return;
        }
        if (pairing.hasPeerKey() && !pairing.isSamePeerKey(msg.key)) {
            if (!inReconnect) {
                // A mid-session re-key with a DIFFERENT key would rotate the
                // session under a binding we already confirmed. Refuse it.
                _logger.warn('Ignoring unexpected public-key after key exchange already completed');
                _showToast(_i18n.t('send.unexpectedRekey'), { type: 'error', duration: 5000 });
                return;
            }
            // The peer changed during the reconnect window (peer swap /
            // MITM attempt). Do not silently re-pair: drop the session and
            // send the user back to scan a fresh QR.
            _logger.error('Receiver public key changed during reconnect; refusing');
            _showToast(_i18n.t('send.peerChangedOnReconnect'), { type: 'error', duration: 0 });
            dropPairing();
            inReconnect = false;
            if (_onScanRequested) _onScanRequested();
            return;
        }

        let res;
        try {
            res = await pairing.acceptPeerKey(msg);
        } catch (e) {
            _logger.error('Failed to complete key exchange: ' + e.message);
            return;
        }
        if (res.status === 'version-mismatch') {
            _logger.error(`Receiver runs protocol version ${msg.protocolVersion}, we run ${window.Protocol.VERSION}`);
            _showToast(_i18n.t('pairing.versionMismatch'), { type: 'error', duration: 0 });
            return;
        }
        if (res.status === 'invalid-key') {
            _logger.warn('Ignoring public-key with an invalid key');
            return;
        }
        if (res.status === 'stale') return;

        // Answer with our public key, then our key-confirm (order matters
        // only for latency: the receiver buffers an early confirm).
        const ourPublicKeyB64 = await window.WebSendCrypto.exportPublicKey(keyPair.publicKey);
        rtc.sendMessage(window.Protocol.build.senderPublicKey(ourPublicKeyB64));
        await sendMessageWithRetry(res.confirmMsg, 'key-confirm');

        if (res.status === 'same-key') {
            // Duplicate public-key with the same key: the receiver missed
            // our reply (dropped before a race winner was locked) or a
            // relay reconnect re-announced it. The binding is kept, so the
            // in-flight encrypted file stays decryptable.
            _logger.info('Re-sent sender-public-key + key-confirm for a duplicate receiver public-key');
            if (inReconnect) {
                inReconnect = false;
                _logger.success('Reconnect: receiver key unchanged, pairing kept');
                restoreSendUiAfterRecovery();
            }
            return;
        }
        _logger.success('Key exchange complete; sent public key and key-confirm, awaiting the receiver key-confirm');
    }

    async function handleKeyConfirm(msg) {
        if (!pairing) return;
        await pairing.handleKeyConfirm(msg);
    }

    function onPairingBound() {
        _logger.success('Pairing confirmed: the receiver proved it holds the same keys');
        if (_onPaired) _onPaired();
        if (pendingReady) maybeFlushReady();
    }

    function onPairingFailed(reason) {
        // Wrong QR secret, a substituted public key, or a silent peer.
        // Accept nothing from this session: tear it down and go back to
        // scanning.
        _logger.error(`Pairing failed (${reason}): key-confirm did not verify`);
        _showToast(_i18n.t('pairing.failed'), { type: 'error', duration: 0 });
        pendingReady = false;
        dropPairing();
        if (rtc) {
            try { rtc.close(); } catch (_) {}
            rtc = null;
        }
        if (_onScanRequested) _onScanRequested();
    }

    function handleReady() {
        // Defense in depth: a malicious receiver can send `ready` without
        // ever sending a valid key-confirm, trying to fast-forward the
        // sender UI into capture mode. Only honour `ready` once our
        // pairing is bound (the receiver's key-confirm opened).
        if (!isBound()) {
            _logger.warn("Deferring 'ready' until the receiver key-confirm verifies");
            // Defer rather than drop: onPairingBound re-triggers
            // maybeFlushReady. Capture mode still only opens when bound.
            pendingReady = true;
            return;
        }
        pendingReady = false;
        _logger.success('Pairing confirmed on both sides, can now send photos');
        window.PeerUI.showVerifiedInSidebar();
        if (_onReadyToCapture) _onReadyToCapture();
        // Flush files queued while disconnected: drain() paused itself on
        // the pairing gate and needs a kick now that both sides
        // bound (covers the full-reconnect path, where the queue
        // survives via resetForReconnect).
        if (window.SenderSend && window.SenderSend.size() > 0) {
            window.SenderSend.drain();
        }
    }

    function maybeFlushReady() {
        if (!pendingReady) return;
        if (!isBound()) return;
        _logger.info('Pairing bound; honoring previously-deferred ready');
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
        'key-confirm': handleKeyConfirm,
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

    // ============ Sending helpers ============

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

    // ============ Cleanup ============

    function cleanup() {
        if (rtc) {
            try { rtc.close(); } catch (_) {}
        }
        rtc = null;
        keyPair = null;
        dropPairing();
        pendingReady = false;
        inReconnect = false;
        lastRoomId = null;
        lastSecret = null;
        lastQrSecret = null;
        if (window.Gallery && typeof window.Gallery.shredLocal === 'function') {
            try { window.Gallery.shredLocal(); } catch (_) {}
        }
        if (window.wakeLockMgr && typeof window.wakeLockMgr.release === 'function') {
            try { window.wakeLockMgr.release(); } catch (_) {}
        }
    }

    /** Pre-room initialization so getRtc() is stable before join(). */
    async function init() {
        keyPair = await window.WebSendCrypto.generateKeyPair();
        rtc = window.Transport.createForSender();
        await rtc.init();
        wireRtcCallbacks();
    }

    // Frozen so a hostile script cannot swap isVerified / getSessionKeys
    // to bypass the pairing gate from outside.
    window.SenderConnect = Object.freeze({
        attach,
        init,
        join,
        reconnect,
        cleanup,
        getRtc: () => rtc,
        // null until the pairing is bound (receiver key-confirm opened)
        getSessionKeys: () => (pairing ? pairing.getSessionKeys() : null),
        // True only when the receiver's key-confirm verified. Callers on
        // the send path must consult this before encrypting/transmitting a
        // photo, so a future code change that advances UI without pairing
        // cannot leak user data.
        isVerified: isBound,
        // For visibilitychange, quick state probe without exposing internals
        connectionLost: () => rtc && rtc.pc && (rtc.pc.connectionState === 'failed' || rtc.pc.connectionState === 'disconnected'),
    });
})();
