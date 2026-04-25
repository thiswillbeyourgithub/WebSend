// Pure: rescales OCR coordinates on a scribe page object so they match
// the original image dimensions instead of the downscaled OCR-input dimensions.
// Mutates `page` and `metrics` in place. Caller must clone first if they
// need to preserve the originals (e.g. cached OCR data).
(function () {
    function rescaleOcrPage(page, metrics, origW, origH) {
        const ocrDims = metrics.dims;
        const scaleX = origW / ocrDims.width;
        const scaleY = origH / ocrDims.height;
        const s = (scaleX + scaleY) / 2;

        if (Math.abs(s - 1) > 0.01 && page && page.lines) {
            for (const line of page.lines) {
                line.bbox.left *= s; line.bbox.top *= s;
                line.bbox.right *= s; line.bbox.bottom *= s;
                if (line.ascHeight) line.ascHeight *= s;
                if (line.xHeight) line.xHeight *= s;
                line.baseline[1] *= s;
                for (const word of line.words) {
                    word.bbox.left *= s; word.bbox.top *= s;
                    word.bbox.right *= s; word.bbox.bottom *= s;
                    if (word.chars) {
                        for (const ch of word.chars) {
                            ch.bbox.left *= s; ch.bbox.top *= s;
                            ch.bbox.right *= s; ch.bbox.bottom *= s;
                        }
                    }
                }
            }
            page.dims = { width: origW, height: origH };
        }

        metrics.dims.width = origW;
        metrics.dims.height = origH;
        return s;
    }

    const api = { rescaleOcrPage };
    if (typeof window !== 'undefined') window.OcrRescale = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
