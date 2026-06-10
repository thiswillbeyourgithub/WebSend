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
    // True between a TransientDisconnectError caught in drain() and a
    // file-resume-offer (or fatal teardown). While paused, the head
    // of the queue keeps its cachedEncryptedData so resume sends the
    // exact same ciphertext bytes (same GCM nonce) and the receiver's
    // partial buffer remains valid.
    let pausedOnTransient = false;

    // -- Wired-in deps (set by attach) --
    let _getRtc = null;
    let _getSharedKey = null;
    let _isVerified = null;
    let _i18n = null;
    let _logger = null;
    let _showToast = null;
    let _getGalleryPhotos = null; // optional; for sentHash/sendStatus updates

    function attach(deps) {
        _getRtc = deps.getRtc;
        _getSharedKey = deps.getSharedKey;
        _isVerified = deps.isVerified || (() => true);
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
        // Word the banner for what is actually queued: "photo(s)" when every
        // item is an image, "file(s)" otherwise (e.g. a PDF or document
        // picked from the file picker), so sending a file no longer says
        // "photo".
        const allImages = queue.length > 0 && queue.every(
            it => it && it.blob && typeof it.blob.type === 'string' && it.blob.type.startsWith('image/'));
        const key = allImages ? 'send.queueSending' : 'send.queueSendingFiles';
        text.textContent = _i18n.t(key).replace('{n}', queue.length);
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
        pausedOnTransient = false;
        updateBanner();
    }

    function size() { return queue.length; }
    function isActive() { return isSending; }

    /**
     * Map a send failure to the most informative user-facing toast so the
     * user understands the cause without opening the logs. Shared by the
     * drain() and resumeDrain() failure paths so the classification lives
     * in one place. Falls back to the generic "please retry" message for
     * unclassified errors.
     */
    function showSendFailureToast(e) {
        const msg = (e && e.message) || '';
        if (msg.includes('timeout')) {
            _showToast(_i18n.t('send.transferTimeout'));
        } else if (msg.includes('Receiver decryption failed')) {
            _showToast(_i18n.t('send.checksumMismatch'));
        } else if ((e && e.name === 'NotReadableError') || /could not be read/i.test(msg)) {
            // The blob/File handle went stale: classically the OS reclaimed
            // the picked file after the app was backgrounded during the
            // picker. Tell the user to re-select it (sticky toast so the
            // longer explanation is readable), not just "please retry".
            _showToast(_i18n.t('send.fileUnreadable'), { type: 'error', duration: 0 });
        } else {
            _showToast(_i18n.t('send.sendFailed'));
        }
    }

    // -- Drain loop --

    /**
     * Drain the send queue serially in the background.
     * Safe to call multiple times; only one drain loop runs at a time.
     */
    async function drain() {
        if (isSending) return;
        if (pausedOnTransient) {
            _logger.info('drain() called while paused on transient drop, skipping');
            return;
        }
        isSending = true;
        updateBanner();

        let successCount = 0;
        while (queue.length > 0) {
            const item = queue[0];
            try {
                if (item.replaceHash && !item._replaceSent) {
                    _getRtc().sendMessage(window.Protocol.build.replaceImage(item.replaceHash));
                    item._replaceSent = true;
                }
                const localHash = await sendOnePhoto(item);
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
                // Transient transport drop mid-send: keep the head of the
                // queue (with its cached encryptedData) and pause until a
                // file-resume-offer arrives via handleResumeOffer.
                if (e && e.transient) {
                    _logger.warn(`Send paused on transient drop at offset ${e.offset}`);
                    item._lastOffset = e.offset | 0;
                    pausedOnTransient = true;
                    isSending = false;
                    updateBanner();
                    return;
                }
                queue.shift();
                if (item.photoId != null) {
                    const gPhoto = _getGalleryPhotos().find(p => p.id === item.photoId);
                    if (gPhoto) gPhoto.sendStatus = 'failed';
                }
                _logger.error('Queued photo failed: ' + e.message);
                showSendFailureToast(e);
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
     * Encrypt and transmit a single photo blob.
     *
     * Encrypts on first call and caches the ciphertext on the queue
     * `item` so a transient transport drop can resume sending the same
     * ciphertext (same GCM nonce) instead of re-encrypting (which
     * would invalidate the receiver's partial buffer).
     *
     * `resumeFromOffset` is propagated to the transport so a relay
     * reconnect after a mid-transfer drop continues from that byte
     * instead of re-sending file-start.
     *
     * Resolves with the plaintext SHA-256 hex when the receiver acks;
     * throws on nack, timeout, or transient drop. A transient drop
     * throws a tagged TransientDisconnectError so drain() can pause
     * the queue head instead of dropping the photo.
     */
    async function sendOnePhoto(item, resumeFromOffset) {
        // Hard gate: refuse to encrypt/transmit unless both sides have
        // confirmed the fingerprint and a shared key was derived. This
        // is independent of the UI gate in handleReady so a future bug
        // that advances the capture flow without verification cannot
        // leak user data over the wire.
        if (!_isVerified()) {
            throw new Error('Refusing to send: peer not verified');
        }
        const blob = item.blob;

        // Lazy-encrypt: only on first attempt. On resume, the cached
        // ciphertext is reused so the receiver's partial buffer stays
        // valid byte-for-byte.
        if (!item._cachedEncryptedData) {
            const photoData = await blob.arrayBuffer();
            _logger.info(`Sending queued photo: ${photoData.byteLength} bytes`);
            item._localHash = await window.WebSendCrypto.sha256Hex(photoData);
            _logger.info(`Plaintext SHA-256: ${item._localHash}`);
            const filename = blob.name || `websend_${Date.now()}.png`;
            // Camera/gallery blobs always carry an explicit image/* type (set
            // by canvas.toBlob). An empty blob.type only happens for a
            // file-picker pass-through of a type the browser does not
            // recognize (e.g. a .img disk image). Defaulting those to
            // image/png mislabels arbitrary binary as a picture, so the
            // receiver tries to render/OCR it and the file can end up
            // discarded as a failed photo. Fall back to a generic type so
            // such files travel as plain downloadable files instead.
            const mimeType = blob.type || 'application/octet-stream';
            item._cachedEncryptedData = await window.WebSendCrypto.encryptWithMetadata(
                photoData,
                { name: filename, mimeType: mimeType, originalSize: photoData.byteLength },
                _getSharedKey()
            );
            _logger.info(`Encrypted size: ${item._cachedEncryptedData.byteLength} bytes (padded)`);
        }
        const encryptedData = item._cachedEncryptedData;

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
        }, resumeFromOffset);
        const elapsed = (Date.now() - xferStart) / 1000;
        const actualRate = elapsed > 0 ? encryptedData.byteLength / elapsed : 0;
        _logger.info(`Transfer complete: ${window.formatRate(actualRate)} avg (${elapsed.toFixed(1)}s, ${encryptedData.byteLength} bytes)`);
        const statsEl = document.getElementById('queue-transfer-stats');
        if (statsEl) statsEl.textContent = '';
        // Drop the cached ciphertext now that it's done so the GC can
        // free a potentially large buffer. _localHash stays for the
        // drain() result.
        const localHash = item._localHash;
        item._cachedEncryptedData = null;
        return localHash;
    }

    /**
     * Handle a file-resume-offer from the receiver after a relay
     * reconnect. The receiver tells us how many bytes of an in-flight
     * file-start it already has. We:
     *
     * - If the head of our queue still holds the matching encryptedData
     *   (same byteLength as the offer's size), reply with
     *   file-resume-ack {offset: received} and resume sending from
     *   that offset.
     * - Otherwise reply with file-resume-ack {offset: 0} so the
     *   receiver discards its partial buffer and expects a fresh
     *   file-start. The queue is then drained normally.
     */
    function handleResumeOffer(msg) {
        const head = queue[0];
        const matches = head
            && head._cachedEncryptedData
            && head._cachedEncryptedData.byteLength === msg.size
            && msg.received > 0
            && msg.received <= msg.size;
        if (!matches) {
            _logger.warn(`file-resume-offer cannot match head of queue (have ${queue.length} item(s), head has cache=${!!(head && head._cachedEncryptedData)}); replying offset=0`);
            try { _getRtc().sendMessage(window.Protocol.build.fileResumeAck(0)); } catch (_) {}
            pausedOnTransient = false;
            // Drain normally if anything is queued.
            if (queue.length > 0) drain();
            return;
        }
        _logger.info(`file-resume-offer matches head, resuming from offset ${msg.received}/${msg.size}`);
        try { _getRtc().sendMessage(window.Protocol.build.fileResumeAck(msg.received)); } catch (_) {}
        pausedOnTransient = false;
        // Resume via a one-shot drain that passes the offset for the head.
        resumeDrain(msg.received);
    }

    async function resumeDrain(resumeFromOffset) {
        if (isSending) return;
        isSending = true;
        updateBanner();
        const item = queue[0];
        try {
            const localHash = await sendOnePhoto(item, resumeFromOffset);
            queue.shift();
            if (item.photoId != null) {
                const gPhoto = _getGalleryPhotos().find(p => p.id === item.photoId);
                if (gPhoto) {
                    gPhoto.sentHash = localHash;
                    gPhoto.sendStatus = 'sent';
                }
            }
            _logger.success('Resumed photo sent and verified by receiver');
        } catch (e) {
            if (e && e.transient) {
                _logger.warn(`Resumed send paused again on transient drop at offset ${e.offset}`);
                item._lastOffset = e.offset | 0;
                pausedOnTransient = true;
                isSending = false;
                updateBanner();
                return;
            }
            queue.shift();
            if (item.photoId != null) {
                const gPhoto = _getGalleryPhotos().find(p => p.id === item.photoId);
                if (gPhoto) gPhoto.sendStatus = 'failed';
            }
            _logger.error('Resumed photo failed: ' + e.message);
            showSendFailureToast(e);
        }
        isSending = false;
        updateBanner();
        // Continue draining anything else still queued.
        if (queue.length > 0) drain();
    }

    // Frozen so a hostile script cannot swap `push` / `drain` with a
    // tampering variant that exfiltrates plaintext or bypasses the
    // SenderConnect.isVerified() gate enforced inside sendOnePhoto.
    window.SenderSend = Object.freeze({
        attach,
        push,
        markBatchEndPending,
        removePhotoById,
        clear,
        size,
        isActive,
        drain,
        updateBanner,
        handleResumeOffer,
    });
})();
