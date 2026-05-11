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
            rtc = new window.WebSendRTC();
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
        window.SenderSend.clear();

        rtc = new window.WebSendRTC();
        await rtc.init();
        wireRtcCallbacks();

        await join(lastRoomId, lastSecret);
    }

    // ============ Key exchange + fingerprint verification ============

    async function handlePublicKey(msg) {
        // Refuse mid-session re-key. Once a shared key has been derived,
        // accepting a new `public-key` message would silently rotate the
        // encryption key to whatever the (possibly hostile) peer chose,
        // while weConfirmed/theyConfirmed remain true from the previous
        // handshake. The user would think they had verified the peer,
        // but every subsequent photo would actually be encrypted to the
        // attacker's new key. Force a clean reconnect to roll the
        // verification state if a re-key is legitimately needed.
        if (sharedKey) {
            _logger.warn('Ignoring unexpected public-key after key exchange already completed');
            _showToast(_i18n.t('send.unexpectedRekey') || 'Unexpected re-key attempt blocked', { type: 'error', duration: 5000 });
            return;
        }
        _logger.info('Received receiver public key, performing key exchange...');
        try {
            const receiverPublicKey = await window.WebSendCrypto.importPublicKey(msg.key);
            sharedKey = await window.WebSendCrypto.deriveSharedKey(keyPair.privateKey, receiverPublicKey);

            // Adapt fingerprint length to active room load
            let fpLength = 12;
            try {
                const statsRes = await fetch('/api/stats');
                if (statsRes.ok) {
                    const stats = await statsRes.json();
                    fpLength = window.WebSendCrypto.computeFingerprintLength(stats.activeRooms);
                }
            } catch (e) {
                _logger.warn('Could not fetch room stats, using max fingerprint length');
            }

            const ourFingerprint = await window.WebSendCrypto.getKeyFingerprint(keyPair.publicKey, fpLength);
            const theirFingerprint = await window.WebSendCrypto.getKeyFingerprint(receiverPublicKey, fpLength);

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
            _logger.warn(`Ignoring premature 'ready' (sharedKey=${!!sharedKey}, weConfirmed=${weConfirmed}, theyConfirmed=${theyConfirmed})`);
            return;
        }
        _logger.success('Both parties verified, can now send photos');
        window.PeerUI.showVerifiedInSidebar();
        if (_onReadyToCapture) _onReadyToCapture();
    }

    function handleTransformNack(msg) {
        const reason = msg.reason || 'unknown';
        _logger.warn(`transform-nack received for ${msg.oldHash?.substring(0, 8)}... (${reason})`);

        const photo = window.Gallery.photos().find(p => p && p.sentHash === msg.oldHash);
        if (!photo) {
            _logger.warn('transform-nack: no local photo matches oldHash, cannot recover');
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

    function confirmFingerprint() {
        weConfirmed = true;
        rtc.sendMessage(window.Protocol.build.fingerprintConfirmed());
    }

    function denyFingerprint() {
        rtc.sendMessage(window.Protocol.build.fingerprintDenied());
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
        rtc = new window.WebSendRTC();
        await rtc.init();
        wireRtcCallbacks();
    }

    window.SenderConnect = {
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
        // For visibilitychange — quick state probe without exposing internals
        connectionLost: () => rtc && rtc.pc && (rtc.pc.connectionState === 'failed' || rtc.pc.connectionState === 'disconnected'),
    };
})();
