/**
 * receive-flow.js
 *
 * Decrypt-and-display pipeline for incoming v2 chunked transfers on the
 * receiver page. Owns the SegmentReceiver lifecycle and the display flow:
 *   handleFileStart → handleFileSegment* → handleFileEnd
 *                                            ↘ addNewReceivedImage
 *                                            ↘ applyImageReplacement
 *
 * Cross-page state (sessionKeys, receivedImages, pendingReplaceHash, etc.) is
 * passed in via ReceiveFlow.attach({...}) once during page init. Globals it
 * reaches via window: SegmentStream, Protocol, Collections, ReceiveCard,
 * ReceiveExport, BgOcr.
 *
 * Exposed as window.ReceiveFlow.
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    let receivedImages = null;
    let _getRtc = null;
    let _logger = null;
    let _i18n = null;
    let _showToast = null;
    let _getSessionKeys = null;
    let _getPendingReplaceHash = null;
    let _setPendingReplaceHash = null;
    let _getConnectionTimestamp = null;
    let _incrementPhotoCount = null;
    let _finalizeReceiveStats = null;
    let _updateExportButton = null;

    function attach(opts) {
        receivedImages = opts.receivedImagesRef;
        _getRtc = opts.getRtc;
        _logger = opts.logger;
        _i18n = opts.i18n;
        _showToast = opts.showToast;
        _getSessionKeys = opts.getSessionKeys;
        _getPendingReplaceHash = opts.getPendingReplaceHash;
        _setPendingReplaceHash = opts.setPendingReplaceHash;
        _getConnectionTimestamp = opts.getConnectionTimestamp;
        _incrementPhotoCount = opts.incrementPhotoCount;
        _finalizeReceiveStats = opts.finalizeReceiveStats;
        _updateExportButton = opts.updateExportButton;
    }

    /**
     * The sender controls metadata.name. Strip control chars, path
     * separators, and Unicode bidi/format characters that would let a
     * hostile peer visually spoof the file extension (e.g. U+202E
     * RIGHT-TO-LEFT OVERRIDE turning "harmlessgpj.exe" into
     * "harmlessexe.jpg" on the card). Cap at 255, drop to empty string
     * if nothing remains. Downstream code falls back to a generated
     * filename when empty.
     */
    function sanitizeMetadataName(name) {
        if (typeof name !== 'string') return '';
        // eslint-disable-next-line no-control-regex
        let cleaned = name.replace(/[\x00-\x1F\x7F/\\]/g, '');
        // Strip Unicode bidi controls (RLO/LRO/PDF/LRE/RLE/LRI/RLI/FSI/PDI),
        // zero-width chars (ZWSP/ZWNJ/ZWJ/LRM/RLM/WJ), and the BOM. These
        // are invisible in rendered text but reverse the displayed order
        // of surrounding characters, so a peer-supplied filename can
        // otherwise present a fake extension on the receive card.
        // ZWSP..RLM           bidi embed/override  WJ      isolates   BOM
        cleaned = cleaned.replace(/[​-‏‪-‮⁠⁦-⁩﻿]/g, '');
        return cleaned.trim().slice(0, 255);
    }

    /**
     * Validate a peer-supplied MIME type.
     *
     * Defense-in-depth: even though we already wrap blob: URLs as
     * application/octet-stream, the raw mimeType value flows into
     *   - fileType discrimination (isImage / isPdf branches),
     *   - the synthesized fallback filename's extension,
     *   - downstream UI text that's read by users deciding whether to open
     *     the file in an external app.
     * Allowing arbitrary peer bytes here lets a hostile sender lie about
     * the type to bypass UI checks ("looks like a PDF, actually JS that
     * tricks me into double-clicking it") or smuggle weird chars into the
     * generated filename. RFC 6838 token chars are [A-Za-z0-9!#$&^_.+-];
     * we accept a slightly tighter subset and bound the length.
     */
    const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;
    function sanitizeMimeType(mt) {
        if (typeof mt !== 'string') return 'application/octet-stream';
        const trimmed = mt.trim().toLowerCase();
        if (trimmed.length === 0 || trimmed.length > 128) return 'application/octet-stream';
        if (!MIME_RE.test(trimmed)) return 'application/octet-stream';
        return trimmed;
    }

    /** Strip mime down to a short, filesystem-safe extension (≤8 chars, alnum). */
    function safeExtFromMime(mimeType) {
        const tail = (mimeType.split('/').pop() || '').split('+')[0] || '';
        const cleaned = tail.replace(/[^a-z0-9]/gi, '').slice(0, 8);
        return cleaned || 'bin';
    }

    /**
     * Files at or below this many plaintext bytes are materialized as a
     * Uint8Array (imgObj.data) so thumbnails, transforms, OCR, and PDF
     * rendering work on them. Above it the file stays Blob-backed only:
     * a 4 GiB ArrayBuffer would defeat the whole point of the chunked
     * format's constant-memory receive path.
     */
    const MATERIALIZE_MAX_BYTES = 64 * 1024 * 1024;

    /**
     * Sanitize peer-supplied metadata and shape a decrypted payload for
     * display (file-end finalization).
     * @param {Object} metadata - Raw peer metadata (sanitized in place)
     * @param {ArrayBuffer|null} data - Verified plaintext, or null for a
     *     blob-only file above MATERIALIZE_MAX_BYTES
     * @param {Blob} blob - The verified plaintext as a Blob
     */
    function buildDecoded(metadata, data, blob) {
        metadata.name = sanitizeMetadataName(metadata.name);
        // Replace the peer-supplied mimeType with a sanitised value before
        // anything else reads it, so the rest of the pipeline (fileType
        // discrimination, fallback filename, BgOcr / Collections / cards)
        // can never see a malformed or oversized string.
        metadata.mimeType = sanitizeMimeType(metadata.mimeType);
        _logger.info(`Decrypted file: ${metadata.name} (${metadata.mimeType}, ${blob.size} bytes)`);

        const fileData = data !== null ? new Uint8Array(data) : null;
        const fileMimeType = metadata.mimeType;
        // Re-wrap with the sanitized MIME; Blob parts are referenced, not
        // copied, so this is O(1) even for a multi-GiB blob-only file.
        const fileBlob = fileData !== null
            ? new Blob([fileData], { type: fileMimeType })
            : new Blob([blob], { type: fileMimeType });
        const isImage = fileMimeType.startsWith('image/');
        const isPdf = fileMimeType === 'application/pdf';
        // Blob-only files are presented as generic downloads regardless of
        // MIME: every image/pdf affordance (thumbnail decode, lightbox,
        // transforms, OCR, mupdf page rendering) needs the materialized
        // bytes and would otherwise re-inflate the file into memory.
        const fileType = fileData === null ? 'other'
            : isImage ? 'image' : isPdf ? 'pdf' : 'other';
        const ext = safeExtFromMime(fileMimeType);
        // photoCount is read here only to seed a fallback filename; the real
        // index is allocated below from receivedImages.length.
        const seq = receivedImages.length + 1;
        const fileName = metadata.name || `websend_${_getConnectionTimestamp()}_${seq}.${ext}`;

        return { metadata, data, fileData, fileMimeType, fileBlob, fileType, fileName };
    }

    async function applyImageReplacement(replaceIdx, decoded) {
        const { fileData, fileMimeType, fileBlob, fileType, fileName } = decoded;
        const oldImg = receivedImages[replaceIdx];
        _logger.info(`Replacing image at index ${replaceIdx}`);

        oldImg.data = fileData;
        oldImg.blob = fileBlob;
        oldImg.mimeType = fileMimeType;
        oldImg.name = fileName;
        oldImg.fileType = fileType;
        oldImg.hash = null;
        // Alias, not a copy: `data` is only ever reassigned to a fresh buffer
        // (here and in transform-replay), never mutated in place, so sharing
        // one buffer with originalData is safe and halves resident memory.
        // If you ever start writing into `data` byte-by-byte, copy here again.
        oldImg.originalData = fileData;
        oldImg.originalMimeType = fileMimeType;

        window.ReceiveCard.setCardImage(replaceIdx, fileBlob, { filename: fileName });

        // The composite hash was already verified segment by segment;
        // it is the file's identity token on both sides.
        const decryptedHash = decoded.precomputedHash;
        oldImg.hash = decryptedHash;
        _logger.info(`Replacement SHA-256: ${decryptedHash}`);
        if (!_getRtc().sendMessage(window.Protocol.build.fileAck(decryptedHash))) {
            _logger.warn('Replacement ack could not be sent (channel closed) — sender will treat transfer as failed');
            _showToast(_i18n.t('receive.ackLost') || 'Connection lost before ack — sender may retry', { type: 'warn' });
            return;
        }
        _logger.success(`Image replaced (index ${replaceIdx}) and ack sent`);
        _showToast(_i18n.t('receive.imageReplaced') || 'Image updated by sender', { type: 'success' });

        window.BgOcr.cancel(replaceIdx);
        window.BgOcr.queue(replaceIdx);
    }

    async function addNewReceivedImage(decoded) {
        const { metadata, fileData, fileMimeType, fileBlob, fileType, fileName } = decoded;
        // makeSafeBlobUrl always wraps in application/octet-stream so that
        // navigating to the URL (right-click "Open in New Tab" on the
        // download link or the thumbnail) cannot render peer-supplied
        // text/html or image/svg+xml inside our origin.
        const fileUrl = window.ReceiveCard.makeSafeBlobUrl(fileBlob);
        const imageIndex = receivedImages.length;
        const imgObj = {
            data: fileData,
            blob: fileBlob,
            mimeType: fileMimeType,
            name: fileName,
            hash: null,
            fileType: fileType,
            // Alias, not a copy: see applyImageReplacement above. `data` is
            // only ever reassigned, never mutated in place, so originalData can
            // share the same buffer and avoid doubling resident memory.
            originalData: fileData,
            originalMimeType: fileMimeType
        };
        receivedImages.push(imgObj);

        const col = window.Collections.getActive();
        col.images.push(imgObj);

        if (fileType !== 'image' && col.images.length === 1 && metadata.name) {
            window.Collections.setName(col.id, metadata.name);
            _logger.info(`Collection renamed to file name: ${metadata.name}`);
        }

        _incrementPhotoCount();
        window.Collections.addReceivedFile(fileUrl, fileName, imageIndex, col.id, fileType, fileBlob.size);

        _updateExportButton();

        if (fileData === null) {
            _showToast(_i18n.t('receive.largeFileBlobOnly'), { type: 'info' });
        }

        if (receivedImages.filter(img => img !== null && img.fileType === 'image').length === 1) {
            window.ReceiveExport.preloadClientZip();
        }

        window.BgOcr.queue(imageIndex);

        // See applyImageReplacement: the composite hash ships precomputed.
        const decryptedHash = decoded.precomputedHash;
        imgObj.hash = decryptedHash;
        _logger.info(`Decrypted SHA-256: ${decryptedHash}`);
        if (!_getRtc().sendMessage(window.Protocol.build.fileAck(decryptedHash))) {
            _logger.warn('Ack could not be sent (channel closed) — sender will treat transfer as failed');
            _showToast(_i18n.t('receive.ackLost') || 'Connection lost before ack — sender may retry', { type: 'warn' });
            return;
        }
        _logger.success('File decrypted, displayed, and ack sent');
    }

    // Display step. The bytes already decrypted correctly, so a failure
    // presenting them must NOT be reported as a decryption failure: doing
    // so would nack and discard a file that arrived intact. Worst case the
    // file is shown as a (broken) thumbnail or a generic download, but it
    // is never thrown away once it decrypted. The sender no longer
    // mislabels unknown file types as image/png (sender-send.js), so a
    // disk image and friends arrive as a plain downloadable file rather
    // than a picture in the first place.
    async function presentDecodedFile(decoded) {
        let replaceIdx = -1;
        const pendingHash = _getPendingReplaceHash();
        if (pendingHash) {
            replaceIdx = receivedImages.findIndex(img => img && img.hash === pendingHash);
            _setPendingReplaceHash(null);
            if (replaceIdx === -1) {
                _logger.warn(`replace-image: old hash not found, adding as new image`);
            }
        }

        try {
            if (replaceIdx !== -1) {
                await applyImageReplacement(replaceIdx, decoded);
            } else {
                await addNewReceivedImage(decoded);
            }
        } catch (e) {
            _logger.error('Failed to display received file: ' + e.message);
        }
    }

    // ============ v2 chunked transfers (file-start / file-segment / file-end) ============
    //
    // The transport assembler is crypto-free in v2: it frames wire records
    // and forwards them here (through receive.html's verification gate) as
    // 'file-segment' events. This section owns the SegmentReceiver that
    // decrypts and verifies them in order.
    //
    // Segment events arrive synchronously from the parser but accept() is
    // async, so everything funnels through one promise chain: without it,
    // back-to-back segments would race and self-reject as out-of-order.

    let _segmentReceiver = null;
    let _segmentChain = Promise.resolve();
    // In-connection retry state: while non-null, a segment-nack went out
    // and every incoming record is dropped until the sender's matching
    // segment-rewind re-keys the receiver. Bounded by _retryCount.
    let _awaitingRewindSeq = null;
    let _retryCount = 0;
    const MAX_TRANSFER_RETRIES = 3;

    function _enqueueSegmentWork(fn) {
        _segmentChain = _segmentChain.then(fn).catch(e => {
            _logger.error('v2 receive pipeline error: ' + e.message);
        });
        return _segmentChain;
    }

    function _nackTransfer(error) {
        _segmentReceiver = null;
        _awaitingRewindSeq = null;
        if (!_getRtc().sendMessage(window.Protocol.build.fileNack(error))) {
            _logger.warn('Nack could not be sent (channel closed), sender will time out');
        }
    }

    /**
     * A record failed verification ('decrypt-failed') or file-end came
     * with records missing ('incomplete'): ask the sender to rewind to
     * the first record we lack and resend (it re-keys with a fresh salt,
     * announced via segment-rewind). The transfer stays alive; incoming
     * records are dropped until that rewind arrives. After
     * MAX_TRANSFER_RETRIES rounds, give up with a file-nack carrying the
     * last failure class (the record count is public on the wire and the
     * auth/missing distinction is not an oracle; both are visible to the
     * transport anyway).
     */
    function _requestRewind(failure) {
        const seq = _segmentReceiver.nextSeq;
        _retryCount++;
        if (_retryCount > MAX_TRANSFER_RETRIES) {
            _logger.error(`v2 transfer still failing after ${MAX_TRANSFER_RETRIES} rewinds; giving up (${failure})`);
            _finalizeReceiveStats();
            _nackTransfer(failure);
            _showToast(_i18n.t('receive.transferIncomplete'), { type: 'error' });
            return;
        }
        _awaitingRewindSeq = seq;
        _logger.warn(`v2 ${failure} at record ${seq}; requesting rewind (retry ${_retryCount}/${MAX_TRANSFER_RETRIES})`);
        if (!_getRtc().sendMessage(window.Protocol.build.segmentNack(seq))) {
            _logger.warn('segment-nack could not be sent (channel closed), sender will time out');
        }
    }

    /** Gated handler for file-start. */
    function handleFileStart(msg) {
        return _enqueueSegmentWork(() => {
            if (msg.v !== 2) {
                // A peer running a different protocol version (e.g. the
                // removed v1 whole-file format). Tell it explicitly instead
                // of letting it time out unexplained.
                _logger.error(`file-start with unsupported version (v=${msg.v}); nacking`);
                _nackTransfer('unsupported-version');
                return;
            }
            const sessionKeys = _getSessionKeys();
            if (!sessionKeys) {
                _logger.error('v2 file-start before key exchange; ignoring');
                return;
            }
            _segmentReceiver = window.SegmentStream.createReceiver({
                sessionKeys,
                saltB64: msg.salt,
                segCount: msg.segCount,
            });
            _awaitingRewindSeq = null;
            _retryCount = 0;
            _logger.info(`v2 transfer started (${msg.segCount} segments)`);
        });
    }

    function handleFileSegment(msg) {
        return _enqueueSegmentWork(async () => {
            // No receiver: the file-start was dropped (unverified peer) or
            // the transfer already failed; drop the record in O(1).
            if (!_segmentReceiver) return;
            // Nacked and waiting for the sender's rewind: everything the
            // sender pipelined before seeing our nack is dead weight.
            if (_awaitingRewindSeq !== null) return;
            const res = await _segmentReceiver.accept(msg.seq, msg.ct);
            if (!res.ok) {
                _logger.error(`v2 segment ${msg.seq} rejected (${res.reason})`);
                _requestRewind('decrypt-failed');
            }
        });
    }

    /**
     * Gated handler for segment-rewind: the sender's answer to our
     * segment-nack. Re-keys the receiver with the fresh salt so the
     * resent records verify. Only a rewind matching the seq WE nacked is
     * honoured; an unsolicited one would let a peer re-key and replay at
     * will.
     */
    function handleSegmentRewind(msg) {
        return _enqueueSegmentWork(() => {
            if (!_segmentReceiver) return;
            if (msg.seq !== _awaitingRewindSeq) {
                _logger.warn(`unsolicited segment-rewind to ${msg.seq} (awaiting ${_awaitingRewindSeq}); ignoring`);
                return;
            }
            _segmentReceiver.rekey(msg.salt, msg.seq);
            _awaitingRewindSeq = null;
            _logger.info(`re-keyed after rewind; resuming verification at record ${msg.seq}`);
        });
    }

    /**
     * Resume state for the reconnect flow: the next record seq this
     * receiver is missing, or null when no transfer is in flight.
     * Awaits the segment chain first so in-flight accepts settle and
     * nextSeq is final (the chain never rejects; _enqueueSegmentWork
     * swallows errors).
     */
    async function getResumeState() {
        await _segmentChain;
        if (!_segmentReceiver) return null;
        return { nextSeq: _segmentReceiver.nextSeq, segCount: _segmentReceiver.segCount };
    }

    /**
     * Apply the sender's file-resume-ack: re-key the in-flight receiver
     * with the fresh salt so records resent from {nextSeq} verify.
     * Resolves with {segCount} (for re-arming the transport's record
     * parser) or null when there is nothing to resume.
     */
    function applyResumeAck(nextSeq, saltB64) {
        return _enqueueSegmentWork(() => {
            if (!_segmentReceiver) {
                _logger.warn('file-resume-ack with no transfer in flight; ignoring');
                return null;
            }
            _segmentReceiver.rekey(saltB64, nextSeq);
            // The reconnect re-key supersedes any in-connection rewind we
            // were waiting for when the transport dropped.
            _awaitingRewindSeq = null;
            return { segCount: _segmentReceiver.segCount };
        });
    }

    /**
     * Drop the in-flight transfer without nacking (the sender told us
     * via file-resume-ack {nextSeq: 0} that it will start over with a
     * fresh file-start).
     */
    function abandonTransfer() {
        return _enqueueSegmentWork(() => {
            _segmentReceiver = null;
            _awaitingRewindSeq = null;
        });
    }

    function handleFileEnd() {
        return _enqueueSegmentWork(async () => {
            if (!_segmentReceiver) return;
            // The sender sent this file-end before seeing our nack; the
            // retried tail ends with a fresh one. Drop it like the
            // records around it.
            if (_awaitingRewindSeq !== null) return;

            if (_segmentReceiver.nextSeq !== _segmentReceiver.segCount + 1) {
                // Records went missing in transit (e.g. a relay dropped
                // frames). Same retry path as a corrupted record: ask for
                // the tail again instead of failing the whole file.
                _logger.error(`v2 file-end after ${_segmentReceiver.nextSeq}/${_segmentReceiver.segCount + 1} records`);
                _requestRewind('incomplete');
                return;
            }

            const receiver = _segmentReceiver;
            _segmentReceiver = null;
            _finalizeReceiveStats();

            const { metadata, blob, compositeHashHex } = await receiver.finish();
            // Above the threshold the file stays Blob-backed: never pull a
            // multi-GiB ArrayBuffer into the tab. buildDecoded presents
            // such files as plain downloads (fileType 'other').
            const materialize = blob.size <= MATERIALIZE_MAX_BYTES;
            const decoded = buildDecoded(metadata && typeof metadata === 'object' ? metadata : {},
                materialize ? await blob.arrayBuffer() : null, blob);
            decoded.precomputedHash = compositeHashHex;
            await presentDecodedFile(decoded);
        });
    }

    window.ReceiveFlow = {
        attach,
        handleFileStart,
        handleFileSegment,
        handleSegmentRewind,
        handleFileEnd,
        getResumeState,
        applyResumeAck,
        abandonTransfer,
        // Exposed for testing the pure pipeline:
        applyImageReplacement,
        addNewReceivedImage,
    };
})();
