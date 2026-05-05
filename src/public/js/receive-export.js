/**
 * receive-export.js
 *
 * Export pipeline for the receive page: ZIP, plain PDF, OCR PDF (scribe.js),
 * plus the per-card "PDF -> images" and "PDF -> OCR" actions for received
 * PDFs (MuPDF). Owns the export modal wiring and the related preload promises
 * (client-zip, scribe). The `scribePreloaded` handle is shared with bg-ocr.js
 * via a getter/clearer bridge.
 *
 * Cross-page references (the `receivedImages` array, selection helpers,
 * collections lookup) are wired in via ReceiveExport.attach({...}) once
 * during page init.
 *
 * Exposed as window.ReceiveExport.
 */
(function () {
    'use strict';

    // Read a Blob/File as a data URL ("data:<mime>;base64,...").
    // Used to feed scribe's ImageCache.nativeSrc, which expects a string source.
    function fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
            reader.readAsDataURL(file);
        });
    }

    // -- Module-private state --
    let exportCollectionId = null;       // null = export all, number = specific collection
    let clientZipPreloaded = null;       // Promise<{downloadZip}> or null
    let scribePreloaded = null;          // Promise<ScribeHandle|null> or null
    let mupdfInstance = null;            // cached MuPDF worker
    let ocrExportInFlight = false;       // re-entry guard for generateOcrPdf

    // -- Wired-in deps (set by attach) --
    let receivedImages = null;
    let i18n = null;
    let logger = null;
    let _getSelectedIndices = null;
    let _updateExportBtn = null;
    let _getCollectionById = null;
    let _getWsConfig = () => (window.__wsConfig || {});

    function attach(opts) {
        receivedImages = opts.receivedImagesRef;
        i18n = opts.i18n;
        logger = opts.logger;
        _getSelectedIndices = opts.getSelectedImageIndices;
        _updateExportBtn = opts.updateExportButton;
        _getCollectionById = opts.getCollectionById;
        if (opts.getWsConfig) _getWsConfig = opts.getWsConfig;
    }

    // -- Bridge for bg-ocr.js: atomic claim. Returns the preloaded promise
    // (or null) and immediately nulls the slot so two concurrent claimers
    // never both think they own the same handle. preloadScribe() will
    // refill the slot on the next call if needed. --
    function claimScribePreloaded() {
        const p = scribePreloaded;
        scribePreloaded = null;
        return p;
    }

    function reset() {
        exportCollectionId = null;
        clientZipPreloaded = null;
        scribePreloaded = null;
        mupdfInstance = null;
    }

    // ============ Modal helpers ============

    function getExportPrefix() {
        if (exportCollectionId !== null) {
            const col = _getCollectionById(exportCollectionId);
            if (col) {
                const safeName = col.name.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').toLowerCase();
                return safeName || 'document';
            }
        }
        return 'websend';
    }

    function openExportModal() {
        exportCollectionId = null;
        document.getElementById('export-modal').classList.remove('hidden');
    }

    function openExportModalForCollection(collectionId) {
        exportCollectionId = collectionId;
        document.getElementById('export-modal').classList.remove('hidden');
    }

    function closeExportModal() {
        document.getElementById('export-modal').classList.add('hidden');
    }

    function getSelectedFormat() {
        const active = document.querySelector('.export-seg-btn.active');
        return active ? active.dataset.format : 'pdf';
    }

    function isToggleActive(id) {
        return document.getElementById(id).classList.contains('active');
    }

    function updateExportOptions() {
        const pdfSelected = getSelectedFormat() === 'pdf';
        document.getElementById('export-pdf-options').style.display = 'block';
        const ocrBtn = document.getElementById('export-ocr');
        ocrBtn.style.display = pdfSelected ? '' : 'none';
        if (!pdfSelected) ocrBtn.classList.remove('active');
    }

    async function handleExportConfirm() {
        const format = getSelectedFormat();
        closeExportModal();
        if (format === 'pdf') {
            await generatePdf();
        } else if (format === 'zip') {
            await generateZip();
        }
    }

    function init() {
        document.getElementById('export-cancel-btn').addEventListener('click', closeExportModal);
        document.getElementById('export-confirm-btn').addEventListener('click', handleExportConfirm);

        document.querySelectorAll('.export-seg-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.export-seg-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                updateExportOptions();
            });
        });

        document.querySelectorAll('.export-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => btn.classList.toggle('active'));
        });

        document.getElementById('export-modal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('export-modal')) {
                closeExportModal();
            }
        });
    }

    // ============ Preloads ============

    function preloadClientZip() {
        if (clientZipPreloaded) return;
        clientZipPreloaded = import('/vendor/client-zip.js').catch(e => {
            logger.warn('client-zip preload failed (will retry on export): ' + e.message);
            clientZipPreloaded = null;
            return null;
        });
    }

    function preloadScribe() {
        if (scribePreloaded) return;
        scribePreloaded = (async () => {
            try {
                logger.info('Preloading OCR engine...');
                const handle = await window.ScribeHandle.create();
                logger.info('OCR engine preloaded');
                return handle;
            } catch (e) {
                logger.warn('OCR preload failed (will retry on export): ' + e.message);
                scribePreloaded = null;
                return null;
            }
        })();
    }

    // ============ Image helpers ============

    /**
     * Convert image data to a B&W PNG blob via Otsu binarization.
     * Used by ZIP export when B&W mode is enabled.
     */
    async function toBWPng(data, mimeType) {
        return window.ImageTransforms.toBlob(await window.ImageTransforms.binarize({ data, mimeType }));
    }

    /**
     * Convert image data to JPEG using canvas, also return dimensions.
     * @param {Uint8Array} data - Raw image bytes
     * @param {string} mimeType - Original MIME type
     * @param {Object} [opts] - Options
     * @param {boolean} [opts.bw=false] - Apply Otsu binarization before encoding
     */
    function toJpegData(data, mimeType, opts = {}) {
        return new Promise((resolve, reject) => {
            const blob = new Blob([data], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                if (opts.bw) {
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    window.ImageTransforms.applyOtsu(imageData);
                    ctx.putImageData(imageData, 0, 0);
                }

                canvas.toBlob(jpegBlob => {
                    if (!jpegBlob) {
                        reject(new Error('Canvas toBlob failed'));
                        return;
                    }
                    jpegBlob.arrayBuffer().then(buf => {
                        resolve({
                            data: new Uint8Array(buf),
                            width: img.width,
                            height: img.height
                        });
                    });
                }, 'image/jpeg', 0.92);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Image load failed'));
            };
            img.src = url;
        });
    }

    /** Format current date for filenames (locale-aware) */
    function formatDateForFilename() {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        return i18n.getLocale() === 'fr'
            ? `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}`
            : `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    }

    // Keeps a near-silent oscillator running so the browser doesn't
    // throttle this tab during long-running OCR. Owns its own ctx + osc
    // so failure paths don't leak audio nodes.
    function makeKeepAlive() {
        let ctx = null, osc = null;
        return {
            start() {
                try {
                    ctx = new (window.AudioContext || window.webkitAudioContext)();
                    osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    gain.gain.value = 0;
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.start();
                } catch (_) { /* best effort */ }
            },
            stop() {
                try { if (osc) osc.stop(); } catch (_) {}
                try { if (ctx) ctx.close(); } catch (_) {}
                osc = null; ctx = null;
            },
        };
    }

    // ============ ZIP / Plain PDF ============

    /**
     * Generate a ZIP of all images using client-zip (preloaded in background).
     * If B&W is checked, images are Otsu-binarized and exported as PNGs.
     * Otherwise, original image data is used with original filenames/MIME types.
     */
    async function generateZip() {
        logger.info('Generating ZIP...');
        const btn = document.getElementById('export-btn');
        btn.disabled = true;
        btn.textContent = i18n.t('receive.generatingZip');

        try {
            const clientZipModule = clientZipPreloaded ? await clientZipPreloaded : await import('/vendor/client-zip.js');
            const { downloadZip } = clientZipModule;

            const bw = isToggleActive('export-bw');
            const selectedIndices = _getSelectedIndices(exportCollectionId !== null ? exportCollectionId : undefined);
            const activeImages = selectedIndices.map(i => receivedImages[i]);

            const files = await Promise.all(activeImages.map(async (img) => {
                if (bw && img.fileType === 'image') {
                    const pngBlob = await toBWPng(img.data, img.mimeType);
                    const name = img.name.replace(/\.[^.]+$/, '.png');
                    return { name, input: pngBlob };
                } else {
                    return { name: img.name, input: new Blob([img.data], { type: img.mimeType }) };
                }
            }));

            const zipBlob = await downloadZip(files).blob();

            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${getExportPrefix()}_${formatDateForFilename()}.zip`;
            a.click();
            URL.revokeObjectURL(url);

            logger.success('ZIP downloaded');
        } catch (e) {
            logger.error('ZIP generation failed: ' + e.message);
            window.showToast('Failed to generate ZIP: ' + e.message);
        } finally {
            btn.disabled = false;
            _updateExportBtn();
        }
    }

    /**
     * PDF generator - uses hand-crafted builder for plain PDF,
     * or scribe.js for OCR (searchable PDF with invisible text layer).
     */
    async function generatePdf() {
        const ocr = isToggleActive('export-ocr');
        if (ocr) {
            await generateOcrPdf();
        } else {
            await generatePlainPdf();
        }
    }

    /**
     * Minimal PDF generator - hand-crafted, no dependencies.
     * PDF is a text-based format; JPEG images embed directly with DCTDecode.
     */
    async function generatePlainPdf() {
        logger.info('Generating PDF...');
        const btn = document.getElementById('export-btn');
        btn.disabled = true;
        btn.textContent = i18n.t('receive.generatingPdf');

        try {
            const bw = isToggleActive('export-bw');
            const selectedIndices = _getSelectedIndices(exportCollectionId !== null ? exportCollectionId : undefined);
            const activeImages = selectedIndices.map(i => receivedImages[i]).filter(img => img.fileType === 'image');
            if (activeImages.length === 0) {
                window.showToast('No images selected for PDF export', { type: 'warn' });
                return;
            }
            const jpegs = await Promise.all(activeImages.map(img => toJpegData(img.data, img.mimeType, { bw })));

            const pdf = window.PdfBuilder.buildPdf(jpegs);
            const blob = new Blob([pdf], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = `${getExportPrefix()}_${formatDateForFilename()}.pdf`;
            a.click();
            URL.revokeObjectURL(url);

            logger.success('PDF downloaded');
        } catch (e) {
            logger.error('PDF generation failed: ' + e.message);
            window.showToast('Failed to generate PDF: ' + e.message);
        } finally {
            btn.disabled = false;
            _updateExportBtn();
        }
    }

    // ============ OCR PDF ============

    /**
     * Full on-demand OCR: import images into scribe, recognize, scale, export.
     * Used as fallback when cached assembly fails.
     */
    async function ocrRecognizeAndExport(scribe, activeImages, btn, signal) {
        logger.info('[OCR fallback] Starting full on-demand OCR for ' + activeImages.length + ' images');

        signal.throwIfAborted();

        const bw = isToggleActive('export-bw');
        const origFiles = await Promise.all(activeImages.map(async (img, i) => {
            let blob;
            if (bw) {
                blob = await toBWPng(img.data, img.mimeType);
            } else {
                blob = new Blob([img.data], { type: img.mimeType });
            }
            return new File([blob], img.name || `image_${i}.jpg`, { type: blob.type });
        }));
        logger.info('[OCR fallback] Built ' + origFiles.length + ' original-quality files');

        const OCR_MAX_PX = 2000;
        const ocrFiles = await Promise.all(origFiles.map(async (file) => {
            const bmp = await createImageBitmap(file);
            const { width, height } = bmp;
            const longest = Math.max(width, height);
            if (longest <= OCR_MAX_PX) { bmp.close(); return file; }
            const scale = OCR_MAX_PX / longest;
            const nw = Math.round(width * scale);
            const nh = Math.round(height * scale);
            const cv = new OffscreenCanvas(nw, nh);
            const ctx = cv.getContext('2d');
            ctx.drawImage(bmp, 0, 0, nw, nh);
            bmp.close();
            const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
            return new File([blob], file.name, { type: 'image/jpeg' });
        }));

        signal.throwIfAborted();

        btn.textContent = i18n.t('receive.ocrProcessing', { count: activeImages.length });
        logger.info('[OCR fallback] Importing downscaled images into scribe');
        await scribe.importFiles(ocrFiles);

        signal.throwIfAborted();

        const cfg = _getWsConfig();
        const ocrLangs = cfg.ocrLangs || ['eng', 'fra'];
        const ocrPsm = cfg.ocrPsm || '12';
        logger.info('[OCR fallback] Running recognition (langs=' + ocrLangs.join(',') + ', psm=' + ocrPsm + ')');
        await scribe.recognize({ langs: ocrLangs, modeAdv: 'lstm', config: { tessedit_pageseg_mode: ocrPsm } });

        signal.throwIfAborted();

        const ImageCache = scribe.data.image;
        const pageMetrics = scribe.data.pageMetrics;
        const ocrPages = scribe.data.ocr.active;
        for (let i = 0; i < origFiles.length; i++) {
            const origBmp = await createImageBitmap(origFiles[i]);
            const origW = origBmp.width;
            const origH = origBmp.height;
            origBmp.close();

            window.OcrRescale.rescaleOcrPage(ocrPages[i], pageMetrics[i], origW, origH);

            const origBase64 = await fileToDataUrl(origFiles[i]);
            const origWrapper = { src: origBase64, n: i, type: 'native', rotated: false, binarized: false };
            ImageCache.nativeSrc[i] = Promise.resolve(origWrapper);
        }

        logger.info('[OCR fallback] Exporting PDF');
        return await scribe.exportData('pdf');
    }

    // Build original-quality File[] for the active images, optionally B&W.
    async function buildOrigFiles(activeImages, { bw }) {
        return Promise.all(activeImages.map(async (img, i) => {
            const blob = bw
                ? await toBWPng(img.data, img.mimeType)
                : new Blob([img.data], { type: img.mimeType });
            return new File([blob], img.name || `image_${i}.jpg`, { type: blob.type });
        }));
    }

    // Splice cached OCR pages onto a scribe that's already imported origFiles.
    // Throws if any image lacks cached data — caller falls back to full OCR.
    async function applyCachedOcrToScribe(scribe, origFiles, activeImages) {
        const ImageCache = scribe.data.image;
        const pageMetrics = scribe.data.pageMetrics;
        for (let i = 0; i < activeImages.length; i++) {
            const cached = activeImages[i].ocrPageData;
            if (!cached || !cached.page) {
                throw new Error(`Missing cached OCR data for image ${i + 1}`);
            }
            const cachedPage = structuredClone(cached.page);
            const cachedMetrics = structuredClone(cached.metrics);

            const origBmp = await createImageBitmap(origFiles[i]);
            const origW = origBmp.width;
            const origH = origBmp.height;
            origBmp.close();

            window.OcrRescale.rescaleOcrPage(cachedPage, cachedMetrics, origW, origH);

            scribe.data.ocr.active[i] = cachedPage;
            pageMetrics[i].dims.width = origW;
            pageMetrics[i].dims.height = origH;

            const origBase64 = await fileToDataUrl(origFiles[i]);
            ImageCache.nativeSrc[i] = Promise.resolve({ src: origBase64, n: i, type: 'native', rotated: false, binarized: false });
        }
    }

    // Pick the best available scribe handle for an export (in order of preference:
    // reuse the bg-OCR scribe if idle, the preloaded one, else create fresh).
    async function acquireScribeForExport() {
        let scribe = window.BgOcr.takeScribeIfIdle();
        if (scribe) {
            logger.info('Reusing background OCR scribe instance');
        } else {
            const claim = claimScribePreloaded();
            if (claim) {
                logger.info('Using preloaded scribe instance');
                scribe = await claim;
            }
        }
        if (!scribe || !scribe.isAlive) {
            logger.info('Initializing new scribe instance for PDF assembly');
            scribe = await window.ScribeHandle.create();
        }
        return scribe;
    }

    async function generateOcrPdf() {
        if (ocrExportInFlight) {
            logger.warn('OCR PDF export already in progress — ignoring duplicate trigger');
            window.showToast(i18n.t('receive.ocrAlreadyRunning') || 'Export already in progress', { type: 'warn' });
            return;
        }

        const btn = document.getElementById('export-btn');
        const selectedIndices = _getSelectedIndices(exportCollectionId !== null ? exportCollectionId : undefined);
        const activeImages = selectedIndices.map(i => receivedImages[i]).filter(img => img.fileType === 'image');
        if (activeImages.length === 0) {
            logger.warn('No images selected for OCR PDF export');
            window.showToast('No images selected for OCR PDF export', { type: 'warn' });
            btn.disabled = false;
            _updateExportBtn();
            return;
        }

        ocrExportInFlight = true;
        logger.info('=== OCR PDF export started ===');
        const exportAbort = new AbortController();
        const signal = exportAbort.signal;
        // Tag the button with this run's abort controller. If a later run
        // somehow installs its own handler before our finally fires, the
        // identity check below prevents us from clearing the new handler.
        btn.__activeExportAbort = exportAbort;

        const imageCount = activeImages.length;
        const needsOcr = activeImages.filter(img => !img.ocrPageData);
        const allCached = needsOcr.length === 0;
        logger.info(`Selected ${imageCount} images: ${imageCount - needsOcr.length} cached, ${needsOcr.length} pending`);

        const showCancelButton = () => {
            btn.disabled = false;
            btn.style.background = '#c62828';
            btn.textContent = i18n.t('receive.ocrCancel');
            btn.onclick = () => { exportAbort.abort(); };
        };
        if (allCached) {
            btn.textContent = i18n.t('receive.ocrProcessing', { count: imageCount });
            btn.disabled = true;
        } else {
            showCancelButton();
        }

        // Cap at 30 min absolute: a 100-image export would otherwise sit on a
        // 5-hour timer if something hung early. The user can always cancel.
        const timeoutMinutes = Math.min(imageCount * 3, 30);
        const timeoutId = setTimeout(() => exportAbort.abort(new Error('OCR_TIMEOUT')), timeoutMinutes * 60000);
        let progressInterval;

        const keepalive = makeKeepAlive();
        keepalive.start();

        let scribe;
        try {
            if (!allCached) {
                for (const img of needsOcr) {
                    const idx = receivedImages.indexOf(img);
                    if (idx !== -1 && !window.BgOcr.isQueued(idx) && !window.BgOcr.isProcessing(idx)) {
                        logger.info(`Queuing image #${idx + 1} for background OCR (was not in queue)`);
                        window.BgOcr.queue(idx);
                    }
                }
                progressInterval = setInterval(() => {
                    const remaining = activeImages.filter(img => !img.ocrPageData).length;
                    if (remaining > 0) {
                        btn.textContent = i18n.t('receive.ocrProcessing', { count: imageCount }) + ` (${imageCount - remaining}/${imageCount})`;
                    }
                }, 500);
                logger.info('Awaiting background OCR completion...');
                await waitForBgOcr(activeImages, signal);
                clearInterval(progressInterval);
                progressInterval = null;
                logger.info('Background OCR settled for all selected images');
            }

            signal.throwIfAborted();
            btn.textContent = i18n.t('receive.ocrProcessing', { count: imageCount });

            const bw = isToggleActive('export-bw');
            const origFiles = await buildOrigFiles(activeImages, { bw });
            scribe = await acquireScribeForExport();
            signal.throwIfAborted();

            logger.info('Importing ' + origFiles.length + ' original images into scribe');
            await scribe.importFiles(origFiles);
            signal.throwIfAborted();

            const assembled = await assembleOcrPdf(scribe, origFiles, activeImages, btn, signal, showCancelButton);
            scribe = assembled.scribe; // assembleOcrPdf may have replaced the handle on cache-failure fallback
            const pdfResult = assembled.pdfResult;

            const pdfBlob = pdfResult instanceof Blob
                ? pdfResult
                : new Blob([pdfResult], { type: 'application/pdf' });
            const url = URL.createObjectURL(pdfBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${getExportPrefix()}_ocr_${formatDateForFilename()}.pdf`;
            a.click();
            URL.revokeObjectURL(url);

            logger.success('=== OCR PDF downloaded successfully ===');
        } catch (e) {
            const isTimeout = signal.reason && signal.reason.message === 'OCR_TIMEOUT';
            if (isTimeout) {
                logger.error(`OCR timed out after ${timeoutMinutes} min`);
                window.showToast(i18n.t('receive.ocrTimeout', { minutes: timeoutMinutes }));
            } else if (e.name === 'AbortError' || signal.aborted) {
                logger.warn('OCR cancelled by user — falling back to plain PDF');
                window.showToast(i18n.t('receive.ocrCancelledFallback'));
                btn.style.background = '#1565c0';
                btn.disabled = true;
                await generatePlainPdf();
                return;
            } else {
                logger.error('OCR PDF generation failed: ' + e.message);
                window.showToast(i18n.t('receive.ocrFailed', { error: e.message }));
            }
        } finally {
            clearTimeout(timeoutId);
            if (progressInterval) clearInterval(progressInterval);
            exportAbort.abort();
            keepalive.stop();
            try { if (scribe) await scribe.dispose(); } catch (e) { logger.warn('scribe.dispose() failed in OCR export cleanup: ' + (e && e.message)); }
            // Only revert the button if we still own it. If a later run took
            // over (impossible while ocrExportInFlight guards entry, but
            // belt-and-braces in case future code adds another writer), don't
            // stomp its state.
            if (btn.__activeExportAbort === exportAbort) {
                btn.disabled = false;
                btn.style.background = '#1565c0';
                btn.onclick = null;
                btn.__activeExportAbort = null;
            }
            ocrExportInFlight = false;
            _updateExportBtn();
            logger.info('=== OCR PDF export finished ===');
        }
    }

    // Wait until every selected image's background OCR has settled, or until
    // the export-abort signal fires (cancel / timeout).
    async function waitForBgOcr(activeImages, signal) {
        await Promise.race([
            Promise.all(activeImages.map(img => img.pendingOcr || Promise.resolve())),
            new Promise((_, reject) => {
                if (signal.aborted) return reject(signal.reason || new DOMException('cancelled', 'AbortError'));
                signal.addEventListener('abort', () => reject(signal.reason || new DOMException('cancelled', 'AbortError')), { once: true });
            }),
        ]);
    }

    // Try to assemble the PDF from cached OCR pages. On any non-abort failure,
    // re-init scribe and fall back to running OCR on demand. Returns
    // { scribe, pdfResult } so the caller can keep using the (possibly
    // replaced) scribe handle for cleanup.
    async function assembleOcrPdf(scribe, origFiles, activeImages, btn, signal, showCancelButton) {
        try {
            logger.info('Assembling PDF from cached OCR data...');
            await applyCachedOcrToScribe(scribe, origFiles, activeImages);
            logger.info('Exporting PDF from cached OCR data');
            const pdfResult = await scribe.exportData('pdf');
            logger.success('PDF assembled from cached OCR data successfully');
            return { scribe, pdfResult };
        } catch (cacheErr) {
            if (cacheErr.name === 'AbortError') throw cacheErr;
            logger.warn('Cached OCR assembly failed: ' + cacheErr.message + ' — falling back to full on-demand OCR');
            window.showToast('Cached OCR failed, running full OCR...', { type: 'warn' });

            try {
                const stillAlive = await scribe.reset();
                if (!stillAlive) scribe = null;
            } catch (e) { logger.warn('scribe.reset() failed, will recreate: ' + (e && e.message)); scribe = null; }
            if (!scribe || !scribe.isAlive) {
                logger.info('[OCR fallback] Re-initializing scribe after cache failure');
                scribe = await window.ScribeHandle.create();
            }
            showCancelButton();
            const pdfResult = await ocrRecognizeAndExport(scribe, activeImages, btn, signal);
            logger.success('[OCR fallback] PDF generated successfully via on-demand OCR');
            return { scribe, pdfResult };
        }
    }

    // ============ Per-PDF Export Functions ============
    // Per-card "Export as images" and "Export as OCR PDF" actions for received PDFs.

    /** Lazy-load MuPDF worker for PDF rendering */
    async function getMuPDF() {
        if (mupdfInstance) return mupdfInstance;
        const { initMuPDFWorker } = await import('/scribe/mupdf/mupdf-async.js');
        mupdfInstance = await initMuPDFWorker();
        return mupdfInstance;
    }

    /**
     * Render all pages of a PDF to PNG data URLs using MuPDF.
     * @param {Uint8Array} pdfData - Raw PDF bytes
     * @param {number} dpi - Render DPI (default 150)
     * @returns {Promise<string[]>} Array of data:image/png;base64,... URLs
     */
    async function renderPdfPages(pdfData, dpi = 150) {
        const mupdf = await getMuPDF();
        const doc = await mupdf.openDocument(pdfData.buffer);
        const pageCount = await mupdf.countPages(doc);
        const pages = [];
        for (let i = 1; i <= pageCount; i++) {
            const dataUrl = await mupdf.drawPageAsPNG(doc, { page: i, dpi });
            pages.push(dataUrl);
        }
        await mupdf.freeDocument(doc);
        return pages;
    }

    /**
     * Export a received PDF as a ZIP of page images.
     */
    async function exportPdfAsImages(imageIndex, btn) {
        const file = receivedImages[imageIndex];
        if (!file || file.fileType !== 'pdf') return;
        if (!btn) { logger.error('exportPdfAsImages: missing btn argument'); return; }
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = i18n.t('receive.pdfExporting');

        try {
            const pages = await renderPdfPages(file.data);
            const zipFiles = [];
            const baseName = file.name.replace(/\.pdf$/i, '');
            for (let i = 0; i < pages.length; i++) {
                const resp = await fetch(pages[i]);
                const blob = await resp.blob();
                const buf = await blob.arrayBuffer();
                zipFiles.push({
                    name: `${baseName}_page_${i + 1}.png`,
                    input: new Uint8Array(buf)
                });
            }

            const clientZipModule = await import('/vendor/client-zip.js');
            const { downloadZip } = clientZipModule;
            const zipBlob = await downloadZip(zipFiles).blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(zipBlob);
            a.download = `${baseName}_pages_${formatDateForFilename()}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
            logger.success(`Exported ${pages.length} pages as ZIP`);
        } catch (e) {
            logger.error('PDF to images export failed: ' + e.message);
            window.showToast('Export failed: ' + e.message, { type: 'error' });
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    }

    /**
     * Export a received PDF as a searchable OCR PDF using scribe.js.
     */
    async function exportPdfAsOcr(imageIndex, btn) {
        const file = receivedImages[imageIndex];
        if (!file || file.fileType !== 'pdf') return;
        if (!btn) { logger.error('exportPdfAsOcr: missing btn argument'); return; }
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = i18n.t('receive.pdfExporting');

        try {
            const pages = await renderPdfPages(file.data, 300);

            const ocrFiles = [];
            for (let i = 0; i < pages.length; i++) {
                const resp = await fetch(pages[i]);
                const blob = await resp.blob();
                ocrFiles.push(new File([blob], `page_${i + 1}.png`, { type: 'image/png' }));
            }

            // Always go through ScribeHandle: it absorbs the clear()/terminate()
            // fork and tracks isAlive so dispose() in finally is idempotent.
            let scribe = null;
            const claim = claimScribePreloaded();
            if (claim) {
                scribe = await claim;
            }
            if (!scribe || !scribe.isAlive) {
                scribe = await window.ScribeHandle.create();
            }

            try {
                const config = _getWsConfig();
                const ocrLangs = (config.ocrLangs || ['eng']).slice(0, 3);
                const ocrPsm = config.ocrPsm || '12';

                await scribe.importFiles(ocrFiles);
                await scribe.recognize({ langs: ocrLangs, modeAdv: 'lstm', config: { tessedit_pageseg_mode: ocrPsm } });

                const pdfResult = await scribe.exportData('pdf');

                const baseName = file.name.replace(/\.pdf$/i, '');
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([pdfResult], { type: 'application/pdf' }));
                a.download = `${baseName}_ocr_${formatDateForFilename()}.pdf`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(a.href);

                logger.success(`Exported OCR PDF (${pages.length} pages)`);
            } finally {
                await scribe.dispose();
            }
        } catch (e) {
            logger.error('PDF OCR export failed: ' + e.message);
            window.showToast('OCR export failed: ' + e.message, { type: 'error' });
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    }

    // -- Public API --
    window.ReceiveExport = {
        attach,
        init,
        reset,
        preloadClientZip,
        preloadScribe,
        openExportModal,
        openExportModalForCollection,
        exportPdfAsImages,
        exportPdfAsOcr,
        claimScribePreloaded,
    };
})();
