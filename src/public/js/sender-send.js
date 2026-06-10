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
    // of the queue keeps its SegmentSender so the resume can rewind it
    // (fresh salt, re-key) and continue from the record the receiver
    // reports in its file-resume-offer.
    let pausedOnTransient = false;

    // -- Wired-in deps (set by attach) --
    let _getRtc = null;
    let _getSessionKeys = null;
    let _isVerified = null;
    let _i18n = null;
    let _logger = null;
    let _showToast = null;
    let _getGalleryPhotos = null; // optional; for sentHash/sendStatus updates

    function attach(deps) {
        _getRtc = deps.getRtc;
        _getSessionKeys = deps.getSessionKeys;
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
        } else if (msg.includes('Receiver decryption failed: incomplete')) {
            // The receiver got file-end with bytes missing (transport-level
            // loss). Distinct from a checksum mismatch: nothing is wrong
            // with the data we sent, a retry will usually succeed.
            _showToast(_i18n.t('send.transferIncomplete'));
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
                // queue (with its SegmentSender) and pause until a
                // file-resume-offer arrives via handleResumeOffer.
                if (e && e.transient) {
                    _logger.warn(`Send paused on transient drop at record ${e.nextSeq}`);
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
     * Transmit a single queued blob as v2 sealed segment records.
     *
     * A SegmentSender is created on first attempt and kept on the queue
     * `item` so a transient transport drop can resume the transfer:
     * plaintext is re-read from the blob one segment at a time
     * (constant memory, no whole-file ciphertext cache), and any rewind
     * re-keys with a fresh salt before resending.
     *
     * `resumeFromSeq` is propagated to the transport so a relay
     * reconnect after a mid-transfer drop continues from that record
     * instead of re-sending file-start. The caller (handleResumeOffer)
     * must have rewound the SegmentSender and sent the file-resume-ack
     * carrying the new salt first.
     *
     * Resolves with the composite file hash hex (the v2 file identity,
     * matching the receiver's file-ack hash) when the receiver acks;
     * throws on nack, timeout, or transient drop. A transient drop
     * throws a tagged TransientDisconnectError so drain() can pause
     * the queue head instead of dropping the photo.
     */
    async function sendOnePhoto(item, resumeFromSeq) {
        // Hard gate: refuse to encrypt/transmit unless both sides have
        // confirmed the fingerprint and a shared key was derived. This
        // is independent of the UI gate in handleReady so a future bug
        // that advances the capture flow without verification cannot
        // leak user data over the wire.
        if (!_isVerified()) {
            throw new Error('Refusing to send: peer not verified');
        }
        const blob = item.blob;

        if (!item._segmentSender) {
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
            item._segmentSender = await window.SegmentStream.createSender({
                blob,
                metadata: { name: filename, mimeType: mimeType, originalSize: blob.size },
                sessionKeys: _getSessionKeys(),
            });
            _logger.info(`Sending queued file: ${blob.size} bytes in ${item._segmentSender.segCount} segments`);
        }
        const segmentSender = item._segmentSender;

        // Fresh (non-resume) attempt on a sender that already advanced:
        // a restart after the receiver declined to resume. Rewind to the
        // start so the new file-start carries a fresh salt.
        if (!resumeFromSeq && segmentSender.nextSeq > 0) {
            await segmentSender.rewind(0);
        }

        const xferStart = Date.now();
        let lastStatsUpdate = 0;
        await _getRtc().sendFile(segmentSender, (percent, offset, totalSize) => {
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
        }, resumeFromSeq);
        const elapsed = (Date.now() - xferStart) / 1000;
        const wireSize = segmentSender.estimatedWireSize;
        const actualRate = elapsed > 0 ? wireSize / elapsed : 0;
        _logger.info(`Transfer complete: ${window.formatRate(actualRate)} avg (${elapsed.toFixed(1)}s, ~${wireSize} bytes)`);
        const statsEl = document.getElementById('queue-transfer-stats');
        if (statsEl) statsEl.textContent = '';
        // The composite hash is the file's identity token on both sides
        // (gallery sentHash, replace/delete flows). Computed from the
        // per-segment digests, so no whole-file buffer is ever needed.
        const localHash = await segmentSender.finishHash();
        item._segmentSender = null;
        return localHash;
    }

    /**
     * Handle a file-resume-offer from the receiver after a relay
     * reconnect. The receiver tells us the next record seq it is
     * missing of an in-flight v2 transfer. We:
     *
     * - If the head of our queue still holds a SegmentSender the offer
     *   can apply to, rewind it to that seq (re-keying with a fresh
     *   salt), reply with file-resume-ack {nextSeq, salt}, and resume
     *   sending from that record.
     * - Otherwise reply with file-resume-ack {nextSeq: 0} so the
     *   receiver discards its partial transfer and expects a fresh
     *   file-start. The queue is then drained normally.
     */
    async function handleResumeOffer(msg) {
        const head = queue[0];
        const segmentSender = head && head._segmentSender;
        const canResume = segmentSender
            && Number.isInteger(msg.nextSeq)
            && msg.nextSeq > 0
            && msg.nextSeq <= segmentSender.segCount + 1;
        if (!canResume) {
            _logger.warn(`file-resume-offer cannot match head of queue (have ${queue.length} item(s), head has sender=${!!segmentSender}, offered nextSeq=${msg.nextSeq}); replying nextSeq=0`);
            try { _getRtc().sendMessage(window.Protocol.build.fileResumeAckV2(0)); } catch (_) {}
            pausedOnTransient = false;
            // Drain normally if anything is queued.
            if (queue.length > 0) drain();
            return;
        }
        // Rewind BEFORE acking: the ack carries the fresh salt the
        // receiver must re-key with before any resent record arrives.
        const { saltB64 } = await segmentSender.rewind(msg.nextSeq);
        _logger.info(`file-resume-offer matches head, resuming from record ${msg.nextSeq}/${segmentSender.segCount + 1}`);
        try { _getRtc().sendMessage(window.Protocol.build.fileResumeAckV2(msg.nextSeq, saltB64)); } catch (_) {}
        pausedOnTransient = false;
        // Resume via a one-shot drain that passes the seq for the head.
        resumeDrain(msg.nextSeq);
    }

    async function resumeDrain(resumeFromSeq) {
        if (isSending) return;
        isSending = true;
        updateBanner();
        const item = queue[0];
        try {
            const localHash = await sendOnePhoto(item, resumeFromSeq);
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
                _logger.warn(`Resumed send paused again on transient drop at record ${e.nextSeq}`);
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
