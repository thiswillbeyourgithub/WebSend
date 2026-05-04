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
 * Depends on globals: rotateImage, flipImage, binarize, cropPerspective
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
     * Apply a single transform operation to image data.
     * @param {Uint8Array} inputData
     * @param {string} inputMimeType
     * @param {Object} transform - { op, corners? }
     * @returns {Promise<{data: Uint8Array, mimeType: string}>}
     */
    async function applyTransformToData(inputData, inputMimeType, transform) {
        const input = { data: inputData, mimeType: inputMimeType };
        switch (transform.op) {
            case 'rotateCW': return rotateImage(input, { degrees: 90 });
            case 'flipH':    return flipImage(input, { axis: 'h' });
            case 'bw':       return binarize(input);
            case 'crop':     return cropPerspective(input, { corners: transform.corners });
            default: throw new Error(`Unknown transform op: ${transform.op}`);
        }
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
            let currentData = imgObj.originalData;
            let currentMimeType = imgObj.originalMimeType;

            for (const t of transforms) {
                const result = await applyTransformToData(currentData, currentMimeType, t);
                currentData = result.data;
                currentMimeType = result.mimeType;
            }

            imgObj.data = currentData;
            imgObj.mimeType = currentMimeType;
            imgObj.ocrPageData = null;

            if (preBWData[replaceIdx]) {
                delete preBWData[replaceIdx];
            }

            window.ReceiveCard.setCardImage(replaceIdx, new Blob([currentData], { type: currentMimeType }));

            logger.success(`Transform applied locally (${transforms.length} ops)`);
            showToast(i18n.t('receive.imageReplaced') || 'Image updated by sender', { type: 'success' });

            BgOcr.cancel(replaceIdx);
            BgOcr.queue(replaceIdx);

        } catch (e) {
            logger.error(`transform-image failed: ${e.message}`);
            sendNack(oldHash, e?.message || 'transform-replay-failed');
        }
    }

    window.TransformReplay = { attach, handle, applyTransformToData };
})();
