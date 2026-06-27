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
    // True when a batch-start should be sent right before the next item
    // goes out. Call sites set this instead of sending batch-start
    // directly so a batch queued while the transport is down still
    // opens correctly once the connection is re-verified.
    let pendingBatchStart = false;
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

    /** Mark that batch-start should be sent before the next item goes out. */
    function markBatchStartPending() {
        pendingBatchStart = true;
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

    /**
     * Replace the blob of a still-queued (not-yet-sent) photo by gallery
     * photoId. Used when the user crops a photo before its first send has
     * started: the bytes captured at push time are stale, so swap in the
     * freshly-cropped blob and drop any half-built SegmentSender so it is
     * rebuilt from the new blob. No-op (returns false) if the item already
     * left the queue.
     * @returns {boolean} true if updated
     */
    function updateQueuedBlob(photoId, blob) {
        const item = queue.find(it => it.photoId === photoId);
        if (!item) return false;
        item.blob = blob;
        item._segmentSender = null;
        updateBanner();
        return true;
    }

    /** Reset all queue state. Called on cleanup / new pairing. */
    function clear() {
        queue.length = 0;
        isSending = false;
        pendingBatchEnd = false;
        pendingBatchStart = false;
        pausedOnTransient = false;
        updateBanner();
    }

    /**
     * Keep the queued blobs across a full reconnect (fresh ECDH keys)
     * but drop everything bound to the old session: SegmentSenders are
     * keyed with the old sessionKeys and must be rebuilt, and a
     * transient pause can no longer be resumed (the receiver's partial
     * transfer used the old keys). Called by SenderConnect.reconnect()
     * instead of clear() so files picked while the transport was down
     * survive the re-pairing; drain() stays paused via the verification
     * gate until the new session is verified.
     */
    function resetForReconnect() {
        pausedOnTransient = false;
        for (const item of queue) {
            item._segmentSender = null;
            item._replaceSent = false;
        }
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
        } else if (msg.includes('file-too-large')) {
            _showToast(_i18n.t('send.fileTooLarge'), { type: 'error' });
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
            // Verification gate for the whole loop. During a (re)connect
            // the session keys are not derived/confirmed yet; instead of
            // failing each item (which used to drop files picked while
            // the transport was down), pause with the queue intact.
            // handleReady / the recovery path in sender-connect.js call
            // drain() again once the peer is verified.
            if (!_isVerified()) {
                _logger.info('drain paused: peer not verified yet; queue kept, will resume after (re)connect');
                isSending = false;
                updateBanner();
                return;
            }
            // Connectivity gate: verification state survives a transient
            // relay drop (the keys are still good), so isVerified() alone
            // let the loop push files into a closed socket; every message
            // silently failed and the file died on "finishHash before all
            // segments were read". Pause exactly like the verification
            // gate; the recovery paths in sender-connect.js re-kick
            // drain() once the transport is back.
            const rtc = _getRtc();
            if (!rtc || (typeof rtc.isConnected === 'function' && !rtc.isConnected())) {
                _logger.info('drain paused: transport not connected; queue kept, will resume after reconnect');
                isSending = false;
                updateBanner();
                return;
            }
            // batch-start deferred by the call site (possibly while the
            // transport was down): open the batch just before the first
            // item actually goes out. Keep the flag on a failed send
            // (transport raced shut after the gate above) so the batch
            // still opens on the post-reconnect drain.
            if (pendingBatchStart) {
                if (!rtc.sendMessage(window.Protocol.build.batchStart())) {
                    _logger.warn('drain paused: batch-start did not go out; queue and batch kept');
                    isSending = false;
                    updateBanner();
                    return;
                }
                pendingBatchStart = false;
            }
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
                // Transient drop before file-start ever left this host:
                // the receiver saw nothing of this file and will never
                // emit a file-resume-offer, so pausing on pausedOnTransient
                // would wedge the queue forever. Stop with the queue
                // intact; the reconnect kicks drain() and the head
                // restarts from scratch.
                if (e && e.transient && e.beforeFileStart) {
                    _logger.warn('Transport closed before file-start; queue kept, will retry after reconnect');
                    isSending = false;
                    updateBanner();
                    return;
                }
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

        // Only close the batch while verified, and only forget the marker
        // once the message actually went out: a silent sendMessage failure
        // (unverified flush, transport racing shut) must leave the flag
        // set for the next drain.
        if (pendingBatchEnd && _isVerified()
            && _getRtc().sendMessage(window.Protocol.build.batchEnd())) {
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

        // Protocol-level cap: a larger blob would need more than
        // MAX_SEG_COUNT records and the receiver would reject the
        // file-start anyway. Refuse up front with a clear toast
        // (showSendFailureToast keys on the 'file-too-large' marker).
        if (blob.size > window.Protocol.MAX_FILE_SIZE) {
            throw new Error(`file-too-large: ${blob.size} bytes exceeds the ${window.Protocol.MAX_FILE_SIZE}-byte cap`);
        }

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
        // Rate/ETA via the shared attempt-local tracker: a resume
        // re-enters here with full byte credit for the already-delivered
        // prefix (offset baselines at estimateWireOffset) but a fresh
        // clock, so dividing the absolute offset by this attempt's
        // elapsed showed wildly inflated rates after a reconnect while
        // the receiver's display deflated symmetrically.
        const rateTracker = window.createRateTracker();
        await _getRtc().sendFile(segmentSender, (percent, offset, totalSize) => {
            const fill = document.getElementById('queue-progress-fill');
            if (fill) fill.style.width = percent + '%';
            const now = Date.now();
            const rate = rateTracker.update(offset, now);
            if (now - lastStatsUpdate >= 200) {
                lastStatsUpdate = now;
                const remaining = rate > 0 ? (totalSize - offset) / rate : Infinity;
                const statsEl = document.getElementById('queue-transfer-stats');
                if (statsEl) statsEl.textContent = window.formatTransferStats(percent, rate, remaining);
            }
        }, resumeFromSeq);
        const elapsed = (Date.now() - xferStart) / 1000;
        // Average over THIS attempt's bytes only; on a resume the prefix
        // delivered before the reconnect was not sent during `elapsed`.
        const attemptWire = segmentSender.estimatedWireSize
            - (resumeFromSeq ? segmentSender.estimateWireOffset(resumeFromSeq) : 0);
        const actualRate = elapsed > 0 ? attemptWire / elapsed : 0;
        _logger.info(`Transfer complete: ${window.formatRate(actualRate)} avg (${elapsed.toFixed(1)}s, ~${attemptWire} bytes this attempt)`);
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
        markBatchStartPending,
        markBatchEndPending,
        removePhotoById,
        updateQueuedBlob,
        clear,
        resetForReconnect,
        size,
        isActive,
        drain,
        updateBanner,
        handleResumeOffer,
    });
})();
