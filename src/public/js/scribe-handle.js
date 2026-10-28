// Single owner of the scribe.js API surface (vendored at /scribe/).
//
// Since scribe.js 0.16 all per-document state (OCR pages, page metrics,
// page images) lives on a `ScribeDoc` object instead of the module-level
// `scribe.data` of earlier versions. A ScribeHandle wraps one ScribeDoc
// and its lifecycle, so the rest of the app (bg-ocr.js, receive-export.js)
// never imports scribe directly and a future scribe upgrade only has to
// touch this file. The OCR engine (Tesseract worker pool) and built-in
// fonts are process-wide in scribe and shared by every handle.
(function () {
    // Tesseract models are self-hosted (server.js serves them at /tessdata)
    // instead of scribe's jsdelivr default: the CSP blocks third-party
    // fetches and WebSend must work on an offline LAN.
    const LANG_PATH = '/tessdata';

    let scribePromise = null;

    // Import and configure the scribe module once. Configuration lives on
    // process-wide objects (scribe.opt, ScribeDoc.defaults), so doing it
    // per handle would be redundant, and it must happen before the first
    // Tesseract worker is created for langPath to apply.
    function loadScribe() {
        if (!scribePromise) {
            scribePromise = import('/scribe/scribe.js').then((m) => {
                const s = m.default;
                s.opt.langPath = LANG_PATH;
                // Exported PDFs keep the original image and add the OCR text
                // as an invisible, selectable/searchable layer on top. This is
                // scribe's default, set explicitly because the whole OCR
                // export feature depends on it.
                s.ScribeDoc.defaults.displayMode = 'invis';
                return s;
            }).catch((e) => {
                // Allow a later retry (e.g. transient network failure).
                scribePromise = null;
                throw e;
            });
        }
        return scribePromise;
    }

    class ScribeHandle {
        constructor(scribe, doc) {
            this._scribe = scribe;
            this._doc = doc;
        }

        static async create() {
            const s = await loadScribe();
            // Warm up the OCR engine and fonts now so the first recognize()
            // does not pay the init cost (this is what preloadScribe relies on).
            await s.init({ ocr: true, font: true });
            return new ScribeHandle(s, new s.ScribeDoc());
        }

        // The underlying ScribeDoc. Callers read and patch per-page state:
        // doc.ocr.active[n] (OcrPage), doc.pageMetrics[n].dims.
        get doc() { return this._doc; }
        get isAlive() { return this._doc !== null; }

        // importFiles replaces any previously imported content of the doc
        // (scribe clears the doc first), so a handle can be reused.
        importFiles(files) { return this._doc.importFiles(files); }
        recognize(opts) { return this._doc.recognize(opts); }
        exportData(fmt) { return this._doc.exportData(fmt); }

        /**
         * Replace the image of page `n` with `dataUrl` (PNG or JPEG).
         * The OCR export uses it to recognize a downscaled copy but embed the
         * original-quality image in the PDF. scribe's PDF writer calls methods
         * on the stored value (ensureSrc, dims lookup), so it must be a real
         * ImageWrapper. Importing scribe's module by the same URL scribe uses
         * internally yields the same module instance, hence the same class.
         * Arguments mirror scribe's own image import (js/import/import.js).
         */
        async setPageImage(n, dataUrl) {
            const { ImageWrapper } = await import('/scribe/js/objects/imageObjects.js');
            this._doc.images.nativeSrc[n] = Promise.resolve(new ImageWrapper(n, dataUrl, 'native', false, false));
        }

        // Drop the doc's content (OCR text, images) but keep the handle
        // usable. Returns true while the handle is alive, false once
        // disposed; callers treat false as "create a new handle".
        async reset() {
            if (!this.isAlive) return false;
            await this._doc.clear();
            return true;
        }

        // Best-effort teardown, safe to call multiple times. clear() wipes
        // recognized text and images from memory (session shredding relies
        // on it), close() releases the doc's PDF workers and fonts.
        async dispose() {
            if (!this.isAlive) return;
            const doc = this._doc;
            this._doc = null;
            try { await doc.clear(); } catch (_) { /* best effort */ }
            try { await doc.close(); } catch (_) { /* best effort */ }
        }

        /**
         * Render every page of a PDF to a PNG data URL with scribe's own PDF
         * renderer (scribe 0.17 dropped the MuPDF build earlier versions
         * shipped). Uses a throwaway ScribeDoc, independent of any handle.
         *
         * @param {Uint8Array} pdfData - Raw PDF bytes.
         * @param {Object} opts
         * @param {number} opts.dpi - Render resolution.
         * @param {number} opts.maxPages - Refuse PDFs with more pages (see
         *   MAX_PDF_RENDER_PAGES in receive-export.js for the rationale).
         * @returns {Promise<string[]>} data:image/png;base64,... URLs, in page order.
         * @throws {Error} if the page count exceeds maxPages or a page fails to render.
         */
        static async renderPdfPages(pdfData, { dpi, maxPages }) {
            const s = await loadScribe();
            const file = new File([pdfData], 'input.pdf', { type: 'application/pdf' });
            // deferText: we only rasterize, so do not block on extracting the
            // PDF's text layer (it runs in the background and dies with close()).
            const doc = await s.openDocument([file], { deferText: true });
            try {
                const pageCount = doc.pageMetrics.length;
                if (pageCount > maxPages) {
                    throw new Error(`PDF has ${pageCount} pages, refusing to render more than ${maxPages}`);
                }
                const pages = [];
                for (let i = 0; i < pageCount; i++) {
                    const res = await doc.renderPageImage(i, { dpi, format: 'png' });
                    // On failure scribe returns a blank PNG with ok=false;
                    // surface it rather than silently exporting a blank page.
                    if (!res.ok) throw new Error(`Failed to render PDF page ${i + 1}: ${res.failReason || 'unknown error'}`);
                    pages.push(res.dataUrl);
                }
                return pages;
            } finally {
                await doc.close();
            }
        }
    }

    if (typeof window !== 'undefined') window.ScribeHandle = ScribeHandle;
    if (typeof module !== 'undefined' && module.exports) module.exports = { ScribeHandle };
})();
