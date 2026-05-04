/**
 * sender-send.js
 *
 * Owns the sender's outgoing photo send queue: enqueueing, serial drain
 * loop, encryption + transmit (sendOnePhoto), per-photo gallery status
 * updates, the sticky progress banner, and the optional batch-end signal.
 *
 * Extracted from send.html to bring the sender side in line with the
 * receiver's modular layout (receive-flow.js, receive-export.js, …).
 *
 * Exposed as window.SenderSend.
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    // -- State --
    const queue = [];
    let isSending = false;
    let pendingBatchEnd = false;

    // -- Wired-in deps (set by attach) --
    let _getRtc = null;
    let _getSharedKey = null;
    let _i18n = null;
    let _logger = null;
    let _showToast = null;
    let _getGalleryPhotos = null; // optional; for sentHash/sendStatus updates

    function attach(deps) {
        _getRtc = deps.getRtc;
        _getSharedKey = deps.getSharedKey;
        _i18n = deps.i18n;
        _logger = deps.logger;
        _showToast = deps.showToast;
        _getGalleryPhotos = deps.getGalleryPhotos || (() => []);
    }

    // -- Banner --

    function updateBanner() {
        const banner = document.getElementById('queue-banner');
        const text = document.getElementById('queue-banner-text');
        if (!banner || !text) return;
        if (queue.length === 0 && !isSending) {
            banner.classList.add('hidden');
            const fill = document.getElementById('queue-progress-fill');
            if (fill) fill.style.width = '0%';
            return;
        }
        banner.classList.remove('hidden');
        text.textContent = _i18n.t('send.queueSending').replace('{n}', queue.length);
    }

    // -- Queue mutation --

    /** Push a photo onto the queue without starting drain. */
    function push(item) {
        queue.push(item);
        updateBanner();
    }

    /** Mark that batch-end should be sent once the queue empties. */
    function markBatchEndPending() {
        pendingBatchEnd = true;
    }

    /**
     * Remove a queued (not-yet-sent) photo by gallery photoId.
     * Used by Gallery.deleteGalleryPhoto.
     * @returns {boolean} true if removed
     */
    function removePhotoById(photoId) {
        const idx = queue.findIndex(item => item.photoId === photoId);
        if (idx === -1) return false;
        queue.splice(idx, 1);
        updateBanner();
        return true;
    }

    /** Reset all queue state. Called on reconnect / cleanup. */
    function clear() {
        queue.length = 0;
        isSending = false;
        pendingBatchEnd = false;
        updateBanner();
    }

    function size() { return queue.length; }
    function isActive() { return isSending; }

    // -- Drain loop --

    /**
     * Drain the send queue serially in the background.
     * Safe to call multiple times; only one drain loop runs at a time.
     */
    async function drain() {
        if (isSending) return;
        isSending = true;
        updateBanner();

        let successCount = 0;
        while (queue.length > 0) {
            const item = queue[0];
            try {
                if (item.replaceHash) {
                    _getRtc().sendMessage(window.Protocol.build.replaceImage(item.replaceHash));
                }
                const localHash = await sendOnePhoto(item.blob);
                queue.shift();
                successCount++;
                if (item.photoId != null) {
                    const gPhoto = _getGalleryPhotos().find(p => p.id === item.photoId);
                    if (gPhoto) {
                        gPhoto.sentHash = localHash;
                        gPhoto.sendStatus = 'sent';
                    }
                }
                _logger.success('Queued photo sent and verified by receiver');
            } catch (e) {
                queue.shift();
                if (item.photoId != null) {
                    const gPhoto = _getGalleryPhotos().find(p => p.id === item.photoId);
                    if (gPhoto) gPhoto.sendStatus = 'failed';
                }
                _logger.error('Queued photo failed: ' + e.message);
                const isTimeout = e.message.includes('timeout');
                const isNack = e.message.includes('Receiver decryption failed');
                if (isTimeout) {
                    _showToast(_i18n.t('send.transferTimeout'));
                } else if (isNack) {
                    _showToast(_i18n.t('send.checksumMismatch'));
                } else {
                    _showToast(_i18n.t('send.sendFailed'));
                }
            }
            updateBanner();
        }

        if (pendingBatchEnd) {
            _getRtc().sendMessage(window.Protocol.build.batchEnd());
            pendingBatchEnd = false;
        }
        isSending = false;
        updateBanner();

        if (successCount === 1) {
            _showToast(_i18n.t('send.transferVerified'), { type: 'success' });
        } else if (successCount > 1) {
            _showToast(_i18n.t('send.allSent').replace('{n}', successCount), { type: 'success' });
        }
    }

    /**
     * Encrypt and transmit a single photo blob over the WebRTC data channel.
     * Resolves with the plaintext SHA-256 hex when the receiver acks; throws
     * on nack or timeout.
     */
    async function sendOnePhoto(blob) {
        const photoData = await blob.arrayBuffer();
        _logger.info(`Sending queued photo: ${photoData.byteLength} bytes`);

        const localHash = await window.WebSendCrypto.sha256Hex(photoData);
        _logger.info(`Plaintext SHA-256: ${localHash}`);

        const filename = blob.name || `websend_${Date.now()}.png`;
        const mimeType = blob.type || 'image/png';

        const encryptedData = await window.WebSendCrypto.encryptWithMetadata(
            photoData,
            { name: filename, mimeType: mimeType, originalSize: photoData.byteLength },
            _getSharedKey()
        );
        _logger.info(`Encrypted size: ${encryptedData.byteLength} bytes (padded)`);

        const xferStart = Date.now();
        let lastStatsUpdate = 0;
        await _getRtc().sendFile(encryptedData, (percent, offset, totalSize) => {
            const fill = document.getElementById('queue-progress-fill');
            if (fill) fill.style.width = percent + '%';
            const now = Date.now();
            if (now - lastStatsUpdate >= 200) {
                lastStatsUpdate = now;
                const elapsed = (now - xferStart) / 1000;
                const rate = elapsed > 0 ? offset / elapsed : 0;
                const remaining = rate > 0 ? (totalSize - offset) / rate : Infinity;
                const statsEl = document.getElementById('queue-transfer-stats');
                if (statsEl) statsEl.textContent = window.formatTransferStats(percent, rate, remaining);
            }
        });
        const elapsed = (Date.now() - xferStart) / 1000;
        const actualRate = elapsed > 0 ? encryptedData.byteLength / elapsed : 0;
        _logger.info(`Transfer complete: ${window.formatRate(actualRate)} avg (${elapsed.toFixed(1)}s, ${encryptedData.byteLength} bytes)`);
        const statsEl = document.getElementById('queue-transfer-stats');
        if (statsEl) statsEl.textContent = '';
        return localHash;
    }

    window.SenderSend = {
        attach,
        push,
        markBatchEndPending,
        removePhotoById,
        clear,
        size,
        isActive,
        drain,
        updateBanner,
    };
})();
