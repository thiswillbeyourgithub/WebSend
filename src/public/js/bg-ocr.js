/**
 * bg-ocr.js
 *
 * Background OCR queue for the receive page. Walks `receivedImages` one at a
 * time, downscales each to <=2000px on the longest side, runs scribe.js OCR,
 * and stores the resulting page data on `img.ocrPageData` for later assembly
 * into a searchable PDF. Renders an OCR status badge on each image card.
 *
 * Each queued image gets an `img.pendingOcr` Promise that resolves when its
 * slot in the queue settles (success, failure, skip, or cancel — never
 * rejects). Exporters await it instead of polling `ocrPageData`.
 *
 * Cross-page references (the `receivedImages` array, the preloaded scribe
 * handle, plus a few callbacks) are wired in via BgOcr.attach({...}) once
 * during page init.
 *
 * Exposed as window.BgOcr.
 */
(function () {
    'use strict';

    // -- State --
    let ocrQueue = [];                // indices into receivedImages waiting for OCR (insertion order)
    const ocrQueueSet = new Set();    // O(1) membership companion (kept in sync with ocrQueue)
    let ocrProcessing = false;        // whether the worker loop is running
    let currentOcrIndex = null;       // index currently being OCR'd
    let bgOcrAbortController = null;  // per-iteration AbortController
    let bgOcrScribe = null;           // reusable scribe handle

    // -- Wired-in deps (set by attach) --
    let receivedImagesRef = null;
    let claimScribePreloaded = () => null;

    function attach(opts) {
        receivedImagesRef = opts.receivedImagesRef;
        if (opts.claimScribePreloaded) claimScribePreloaded = opts.claimScribePreloaded;
    }

    // -- Per-image promise plumbing --
    function ensureOcrPromise(img) {
        if (img._resolveOcr) return;
        img.pendingOcr = new Promise(resolve => { img._resolveOcr = resolve; });
    }
    function settleOcrPromise(img) {
        if (!img) return;
        const r = img._resolveOcr;
        img._resolveOcr = null;
        img.pendingOcr = null;
        if (r) r();
    }

    /**
     * Queue an image for background OCR processing.
     * Only queues images (not PDFs or other file types).
     */
    function queue(imageIndex) {
        const img = receivedImagesRef[imageIndex];
        if (!img || img.fileType !== 'image') return;
        img.ocrPageData = null; // reset any previous result
        ensureOcrPromise(img);
        if (!ocrQueueSet.has(imageIndex)) {
            ocrQueue.push(imageIndex);
            ocrQueueSet.add(imageIndex);
            window.logger.info(`[BG-OCR] Queued image #${imageIndex + 1} (queue length: ${ocrQueue.length})`);
        }
        refreshBadge(imageIndex);
        processOcrQueue();
    }

    /**
     * Cancel background OCR for a specific image (e.g. when replaced or discarded).
     */
    function cancel(imageIndex) {
        const wasQueued = ocrQueueSet.has(imageIndex);
        const wasProcessing = currentOcrIndex === imageIndex;
        if (wasQueued) {
            ocrQueue = ocrQueue.filter(i => i !== imageIndex);
            ocrQueueSet.delete(imageIndex);
        }
        if (wasProcessing) {
            bgOcrAbortController?.abort();
        }
        const img = receivedImagesRef[imageIndex];
        const hadCachedData = img && img.ocrPageData;
        if (img) img.ocrPageData = null;
        settleOcrPromise(img);
        refreshBadge(imageIndex);
        if (wasQueued || wasProcessing || hadCachedData) {
            window.logger.info(`[BG-OCR] Cancelled OCR for image #${imageIndex + 1} (was: ${wasProcessing ? 'processing' : wasQueued ? 'queued' : 'cached'})`);
        }
    }

    /** Returns img.pendingOcr if any, else a resolved promise. */
    function waitFor(imageIndex) {
        const img = receivedImagesRef[imageIndex];
        return (img && img.pendingOcr) || Promise.resolve();
    }

    function isQueued(imageIndex) {
        return ocrQueueSet.has(imageIndex);
    }

    function isProcessing(imageIndex) {
        return currentOcrIndex === imageIndex;
    }

    /**
     * Hand the bg-OCR scribe instance over to a caller (typically
     * acquireScribeForExport). Only releases it if the worker is not
     * currently using it. Caller becomes responsible for dispose().
     */
    function takeScribeIfIdle() {
        if (bgOcrScribe && bgOcrScribe.isAlive && !ocrProcessing) {
            const s = bgOcrScribe;
            bgOcrScribe = null;
            return s;
        }
        return null;
    }

    /** Clear all queue state (used by cleanupAllData). */
    function reset() {
        ocrQueue = [];
        ocrQueueSet.clear();
        bgOcrAbortController?.abort();
        currentOcrIndex = null;
    }

    /**
     * Update the OCR status badge on an image card.
     */
    function refreshBadge(imageIndex) {
        const card = document.querySelector(`.received-image-item[data-image-index="${imageIndex}"]`);
        if (!card) return;
        let badge = card.querySelector('.ocr-badge');
        const img = receivedImagesRef[imageIndex];
        if (!img || img.fileType !== 'image') {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'ocr-badge';
            badge.style.cssText = 'position: absolute; bottom: 8px; left: 8px; background: rgba(0,0,0,0.6); color: #fff; font-size: 0.75em; padding: 2px 7px; border-radius: 4px; pointer-events: none;';
            const thumbContainer = card.querySelector('.image-thumb-container');
            if (thumbContainer) thumbContainer.appendChild(badge);
        }
        if (img.ocrPageData) {
            badge.textContent = 'OCR ✓';
            badge.style.background = 'rgba(46,125,50,0.75)';
        } else if (currentOcrIndex === imageIndex) {
            badge.textContent = 'OCR…';
            badge.style.background = 'rgba(21,101,192,0.75)';
        } else if (ocrQueueSet.has(imageIndex)) {
            badge.textContent = 'OCR ⏳';
            badge.style.background = 'rgba(0,0,0,0.6)';
        } else {
            badge.remove();
        }
    }

    /**
     * Downscale a single image for OCR (max 2000px on longest side).
     * Returns a Promise<File> suitable for scribe.importFiles().
     * Returns null if the image has been discarded or is invalid.
     */
    async function downscaleForOcr(idx) {
        const img = receivedImagesRef[idx];
        if (!img || img.fileType !== 'image') return null;
        const OCR_MAX_PX = 2000;
        const blob = new Blob([img.data], { type: img.mimeType });
        const bmp = await createImageBitmap(blob);
        const { width, height } = bmp;
        const longest = Math.max(width, height);
        if (longest <= OCR_MAX_PX) {
            bmp.close();
            return new File([blob], img.name || 'image.jpg', { type: img.mimeType });
        }
        const scale = OCR_MAX_PX / longest;
        const nw = Math.round(width * scale);
        const nh = Math.round(height * scale);
        const cv = new OffscreenCanvas(nw, nh);
        const ctx = cv.getContext('2d');
        ctx.drawImage(bmp, 0, 0, nw, nh);
        bmp.close();
        const scaledBlob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        return new File([scaledBlob], img.name || 'image.jpg', { type: 'image/jpeg' });
    }

    /**
     * Process the background OCR queue one image at a time.
     * Downscaling of the next image is pipelined concurrently with the
     * current recognize() call (createImageBitmap / OffscreenCanvas run
     * off the main thread, so this is genuine parallelism).
     */
    async function processOcrQueue() {
        if (ocrProcessing) return;
        ocrProcessing = true;
        const logger = window.logger;
        logger.info(`[BG-OCR] Queue processing started (${ocrQueue.length} item(s))`);

        // Map: imageIndex -> Promise<File|null> for pre-downscaled images
        const pendingDownscale = new Map();

        // Pre-start downscaling the first queued image immediately
        if (ocrQueue.length > 0) {
            const firstIdx = ocrQueue[0];
            pendingDownscale.set(firstIdx, downscaleForOcr(firstIdx));
        }

        try {
            while (ocrQueue.length > 0) {
                const idx = ocrQueue.shift();
                ocrQueueSet.delete(idx);

                // Pre-start downscaling the next image in queue right away
                if (ocrQueue.length > 0) {
                    const nextIdx = ocrQueue[0];
                    if (!pendingDownscale.has(nextIdx)) {
                        pendingDownscale.set(nextIdx, downscaleForOcr(nextIdx));
                    }
                }

                const img = receivedImagesRef[idx];
                if (!img || img.fileType !== 'image') {
                    logger.info(`[BG-OCR] Skipping image #${idx + 1}: ${!img ? 'null/discarded' : 'not an image (type=' + img.fileType + ')'}`);
                    pendingDownscale.delete(idx);
                    settleOcrPromise(img);
                    continue;
                }
                if (img.ocrPageData) {
                    logger.info(`[BG-OCR] Skipping image #${idx + 1}: already has cached OCR data`);
                    pendingDownscale.delete(idx);
                    settleOcrPromise(img);
                    continue;
                }

                currentOcrIndex = idx;
                bgOcrAbortController = new AbortController();
                refreshBadge(idx);
                logger.info(`[BG-OCR] Starting OCR for image #${idx + 1} (${ocrQueue.length} remaining in queue)`);

                try {
                    // Get or init scribe handle
                    if (!bgOcrScribe || !bgOcrScribe.isAlive) {
                        const preloaded = claimScribePreloaded();
                        if (preloaded) {
                            bgOcrScribe = await preloaded;
                        }
                        if (!bgOcrScribe || !bgOcrScribe.isAlive) {
                            bgOcrScribe = await window.ScribeHandle.create();
                        }
                    }

                    if (bgOcrAbortController.signal.aborted) { logger.info(`[BG-OCR] Aborted for image #${idx + 1}`); pendingDownscale.delete(idx); continue; }

                    // Retrieve pre-downscaled file (already running in parallel) or downscale now
                    const ocrFile = pendingDownscale.has(idx)
                        ? await pendingDownscale.get(idx)
                        : await downscaleForOcr(idx);
                    pendingDownscale.delete(idx);

                    if (!ocrFile) { logger.info(`[BG-OCR] Skipping image #${idx + 1}: discarded during downscale`); continue; }

                    if (bgOcrAbortController.signal.aborted) { logger.info(`[BG-OCR] Aborted for image #${idx + 1}`); continue; }

                    await bgOcrScribe.importFiles([ocrFile]);

                    if (bgOcrAbortController.signal.aborted) { logger.info(`[BG-OCR] Aborted for image #${idx + 1}`); continue; }

                    // Pre-start downscaling the next image while recognize() runs
                    // (createImageBitmap / OffscreenCanvas are truly async — off-thread)
                    if (ocrQueue.length > 0) {
                        const nextIdx = ocrQueue[0];
                        if (!pendingDownscale.has(nextIdx)) {
                            pendingDownscale.set(nextIdx, downscaleForOcr(nextIdx));
                            logger.info(`[BG-OCR] Pre-downscaling image #${nextIdx + 1} while recognizing #${idx + 1}`);
                        }
                    }

                    const ocrLangs = window.__wsConfig?.ocrLangs || ['eng', 'fra'];
                    const ocrPsm = window.__wsConfig?.ocrPsm || '12';
                    await bgOcrScribe.recognize({ langs: ocrLangs, modeAdv: 'lstm', config: { tessedit_pageseg_mode: ocrPsm } });

                    if (bgOcrAbortController.signal.aborted) { logger.info(`[BG-OCR] Aborted for image #${idx + 1}`); continue; }

                    // Clone OCR result data — use structuredClone to handle circular refs
                    const pageData = bgOcrScribe.data.ocr.active[0];
                    const metrics = bgOcrScribe.data.pageMetrics[0];
                    const clonedPage = structuredClone(pageData);
                    const clonedMetrics = structuredClone(metrics);

                    // Store on the image object
                    img.ocrPageData = { page: clonedPage, metrics: clonedMetrics };

                    logger.success(`[BG-OCR] Completed for image #${idx + 1}`);

                    // Reset scribe state for next image (drops handle if scribe only supports terminate)
                    const stillAlive = await bgOcrScribe.reset();
                    if (!stillAlive) bgOcrScribe = null;
                } catch (e) {
                    if (bgOcrAbortController.signal.aborted) {
                        logger.info(`[BG-OCR] Aborted for image #${idx + 1} (edit/discard/replace)`);
                    } else {
                        logger.warn(`[BG-OCR] Failed for image #${idx + 1}: ${e.message} — will fall back to on-demand OCR at export`);
                    }
                    // Try to reset scribe for next image
                    try {
                        if (bgOcrScribe) {
                            const stillAlive = await bgOcrScribe.reset();
                            if (!stillAlive) bgOcrScribe = null;
                        }
                    } catch (_) { bgOcrScribe = null; }
                } finally {
                    currentOcrIndex = null;
                    bgOcrAbortController = null;
                    // Resolve waiters whether OCR succeeded, failed, or aborted.
                    // ocrPageData reflects the outcome; consumers check it.
                    settleOcrPromise(receivedImagesRef[idx]);
                    refreshBadge(idx);
                }
            }
        } finally {
            ocrProcessing = false;
            logger.info('[BG-OCR] Queue processing finished');
        }
    }

    window.BgOcr = {
        attach,
        queue,
        cancel,
        waitFor,
        refreshBadge,
        isQueued,
        isProcessing,
        takeScribeIfIdle,
        reset,
    };
})();
