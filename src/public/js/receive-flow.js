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
     * The sender controls metadata.name. Strip control chars and path
     * separators, cap at 255, drop to empty string if nothing remains.
     * Downstream code falls back to a generated filename when empty.
     */
    function sanitizeMetadataName(name) {
        if (typeof name !== 'string') return '';
        // eslint-disable-next-line no-control-regex
        const cleaned = name.replace(/[\x00-\x1F\x7F/\\]/g, '').trim().slice(0, 255);
        return cleaned;
    }

    async function decryptIncomingFile(blob) {
        const sharedKey = _getSharedKey();
        const encryptedData = await blob.arrayBuffer();
        const { metadata, data } = await window.WebSendCrypto.decryptWithMetadata(encryptedData, sharedKey);
        metadata.name = sanitizeMetadataName(metadata.name);
        _logger.info(`Decrypted file: ${metadata.name} (${metadata.mimeType}, ${metadata.originalSize} bytes)`);

        const fileData = new Uint8Array(data);
        const fileMimeType = metadata.mimeType;
        const fileBlob = new Blob([fileData], { type: fileMimeType });
        const isImage = fileMimeType.startsWith('image/');
        const isPdf = fileMimeType === 'application/pdf';
        const fileType = isImage ? 'image' : isPdf ? 'pdf' : 'other';
        const ext = fileMimeType.split('/').pop().split('+')[0] || 'bin';
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
        const fileUrl = URL.createObjectURL(fileBlob);
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
            _logger.error('Failed to decrypt photo: ' + e.message);
            if (!_getRtc().sendMessage(window.Protocol.build.fileNack(e.message))) {
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
