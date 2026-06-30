/**
 * Remote transform-replay protocol (receiver side).
 *
 * When the sender mutates an already-sent photo (rotateCW / flipH / bw / crop),
 * it sends a `transform-image` message instead of re-uploading. We look up the
 * image by its original hash, replay the transform list against the stored
 * `originalData`, swap the card's blob URL, and restart background OCR.
 *
 * On failure (unknown hash, missing original, transform error), we send a
 * `transform-nack` so the sender can fall back to a full re-send.
 *
 * Depends on globals: window.ImageTransforms.applyOp/applyOps
 * (js/image-transforms.js); rtc, logger, i18n, showToast; window.BgOcr.
 *
 * State injected via attach(): receivedImages, preBWData.
 */
(function () {
    'use strict';

    let receivedImages = null;
    let preBWData = null;

    function attach(opts) {
        receivedImages = opts.receivedImages;
        preBWData = opts.preBWData;
    }

    /**
     * Apply a single transform operation to image data. Thin wrapper kept for
     * callers/tests; the op vocabulary itself lives in ImageTransforms.applyOp
     * so the sender and receiver share one implementation.
     * @param {Uint8Array} inputData
     * @param {string} inputMimeType
     * @param {Object} transform - { op, corners? }
     * @returns {Promise<{data: Uint8Array, mimeType: string}>}
     */
    async function applyTransformToData(inputData, inputMimeType, transform) {
        return window.ImageTransforms.applyOp({ data: inputData, mimeType: inputMimeType }, transform);
    }

    function sendNack(oldHash, reason) {
        try {
            rtc.sendMessage(Protocol.build.transformNack(oldHash, reason));
        } catch (e) {
            logger.error('failed to send transform-nack: ' + e.message);
        }
    }

    async function handle(oldHash, transforms) {
        const replaceIdx = receivedImages.findIndex(img => img && img.hash === oldHash);
        if (replaceIdx === -1) {
            logger.warn(`transform-image: hash ${oldHash} not found, ignoring`);
            sendNack(oldHash, 'unknown-hash');
            return;
        }

        const imgObj = receivedImages[replaceIdx];
        if (!imgObj.originalData) {
            logger.warn('transform-image: no originalData stored, ignoring');
            sendNack(oldHash, 'missing-original');
            return;
        }

        try {
            const result = await window.ImageTransforms.applyOps(
                { data: imgObj.originalData, mimeType: imgObj.originalMimeType },
                transforms
            );

            imgObj.data = result.data;
            imgObj.mimeType = result.mimeType;
            imgObj.ocrPageData = null;
            // The sender just redefined this image; any handle positions the
            // receiver remembered from a local crop no longer correspond.
            imgObj.lastCropCorners = null;

            if (preBWData[replaceIdx]) {
                delete preBWData[replaceIdx];
            }

            window.ReceiveCard.setCardImage(replaceIdx, new Blob([currentData], { type: currentMimeType }));

            logger.success(`Transform applied locally (${transforms.length} ops)`);
            showToast(i18n.t('receive.imageReplaced'), { type: 'success' });

            BgOcr.cancel(replaceIdx);
            BgOcr.queue(replaceIdx);

        } catch (e) {
            // Local logger gets the full message; the peer only sees a
            // constant tag so a hostile sender cannot use the receiver
            // as an oracle for distinguishing canvas / image-decode /
            // image-transforms internal failure modes.
            logger.error(`transform-image failed: ${e.message}`);
            sendNack(oldHash, 'transform-replay-failed');
        }
    }

    function reset() {
        if (preBWData && typeof preBWData === 'object') {
            for (const k of Object.keys(preBWData)) delete preBWData[k];
        }
    }

    window.TransformReplay = { attach, handle, applyTransformToData, reset };
})();
