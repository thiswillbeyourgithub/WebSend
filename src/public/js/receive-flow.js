/**
 * receive-flow.js
 *
 * Decrypt-and-display pipeline for incoming encrypted-file messages on the
 * receiver page. Owns the three-step flow:
 *   handleEncryptedFile → decryptIncomingFile → addNewReceivedImage
 *                                            ↘ applyImageReplacement
 *
 * Cross-page state (sharedKey, receivedImages, pendingReplaceHash, etc.) is
 * passed in via ReceiveFlow.attach({...}) once during page init. Globals it
 * reaches via window: WebSendCrypto, Protocol, Collections, ReceiveCard,
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
    let _getSharedKey = null;
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
        _getSharedKey = opts.getSharedKey;
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

    async function decryptIncomingFile(blob) {
        const sharedKey = _getSharedKey();
        const encryptedData = await blob.arrayBuffer();
        const { metadata, data } = await window.WebSendCrypto.decryptWithMetadata(encryptedData, sharedKey);
        metadata.name = sanitizeMetadataName(metadata.name);
        // Replace the peer-supplied mimeType with a sanitised value before
        // anything else reads it, so the rest of the pipeline (fileType
        // discrimination, fallback filename, BgOcr / Collections / cards)
        // can never see a malformed or oversized string.
        metadata.mimeType = sanitizeMimeType(metadata.mimeType);
        _logger.info(`Decrypted file: ${metadata.name} (${metadata.mimeType}, ${metadata.originalSize} bytes)`);

        const fileData = new Uint8Array(data);
        const fileMimeType = metadata.mimeType;
        const fileBlob = new Blob([fileData], { type: fileMimeType });
        const isImage = fileMimeType.startsWith('image/');
        const isPdf = fileMimeType === 'application/pdf';
        const fileType = isImage ? 'image' : isPdf ? 'pdf' : 'other';
        const ext = safeExtFromMime(fileMimeType);
        // photoCount is read here only to seed a fallback filename; the real
        // index is allocated below from receivedImages.length.
        const seq = receivedImages.length + 1;
        const fileName = metadata.name || `websend_${_getConnectionTimestamp()}_${seq}.${ext}`;

        return { metadata, data, fileData, fileMimeType, fileBlob, fileType, fileName };
    }

    async function applyImageReplacement(replaceIdx, decoded) {
        const { data, fileData, fileMimeType, fileBlob, fileType, fileName } = decoded;
        const oldImg = receivedImages[replaceIdx];
        _logger.info(`Replacing image at index ${replaceIdx}`);

        oldImg.data = fileData;
        oldImg.mimeType = fileMimeType;
        oldImg.name = fileName;
        oldImg.fileType = fileType;
        oldImg.hash = null;
        oldImg.originalData = new Uint8Array(fileData);
        oldImg.originalMimeType = fileMimeType;

        window.ReceiveCard.setCardImage(replaceIdx, fileBlob, { filename: fileName });

        const decryptedHash = await window.WebSendCrypto.sha256Hex(data);
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
        const { metadata, data, fileData, fileMimeType, fileBlob, fileType, fileName } = decoded;
        // makeSafeBlobUrl always wraps in application/octet-stream so that
        // navigating to the URL (right-click "Open in New Tab" on the
        // download link or the thumbnail) cannot render peer-supplied
        // text/html or image/svg+xml inside our origin.
        const fileUrl = window.ReceiveCard.makeSafeBlobUrl(fileData);
        const imageIndex = receivedImages.length;
        const imgObj = {
            data: fileData,
            mimeType: fileMimeType,
            name: fileName,
            hash: null,
            fileType: fileType,
            originalData: new Uint8Array(fileData),
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
        window.Collections.addReceivedFile(fileUrl, fileName, imageIndex, col.id, fileType, fileData.byteLength);

        _updateExportButton();

        if (receivedImages.filter(img => img !== null && img.fileType === 'image').length === 1) {
            window.ReceiveExport.preloadClientZip();
        }

        window.BgOcr.queue(imageIndex);

        const decryptedHash = await window.WebSendCrypto.sha256Hex(data);
        imgObj.hash = decryptedHash;
        _logger.info(`Decrypted SHA-256: ${decryptedHash}`);
        if (!_getRtc().sendMessage(window.Protocol.build.fileAck(decryptedHash))) {
            _logger.warn('Ack could not be sent (channel closed) — sender will treat transfer as failed');
            _showToast(_i18n.t('receive.ackLost') || 'Connection lost before ack — sender may retry', { type: 'warn' });
            return;
        }
        _logger.success('File decrypted, displayed, and ack sent');
    }

    async function handleEncryptedFile(msg) {
        _logger.info('Received encrypted file, decrypting with metadata...');
        _finalizeReceiveStats();

        if (!_getSharedKey()) {
            _logger.error('Cannot decrypt - key exchange not complete');
            return;
        }

        try {
            const decoded = await decryptIncomingFile(msg.blob);

            let replaceIdx = -1;
            const pendingHash = _getPendingReplaceHash();
            if (pendingHash) {
                replaceIdx = receivedImages.findIndex(img => img && img.hash === pendingHash);
                _setPendingReplaceHash(null);
                if (replaceIdx === -1) {
                    _logger.warn(`replace-image: old hash not found, adding as new image`);
                }
            }

            if (replaceIdx !== -1) {
                await applyImageReplacement(replaceIdx, decoded);
            } else {
                await addNewReceivedImage(decoded);
            }
        } catch (e) {
            // Local logger gets the full message; the peer only sees a
            // constant. A peer-facing string would otherwise turn the
            // receiver into an oracle for distinguishing AES-GCM tag
            // failures from JSON parse errors / metadata-length
            // overflows / missing keys, which lets a hostile sender
            // narrow down probing attacks against the crypto layer.
            _logger.error('Failed to decrypt photo: ' + e.message);
            if (!_getRtc().sendMessage(window.Protocol.build.fileNack('decrypt-failed'))) {
                _logger.warn('Nack could not be sent (channel closed) — sender will time out');
            }
        }
    }

    window.ReceiveFlow = {
        attach,
        handleEncryptedFile,
        // Exposed for testing the pure pipeline:
        decryptIncomingFile,
        applyImageReplacement,
        addNewReceivedImage,
    };
})();
