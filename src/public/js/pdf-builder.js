// Hand-rolled minimal PDF builder. Emits a PDF 1.4 document with one page per
// JPEG image, page sized exactly to the image (no margins, no scaling).
// Extracted from receive.html so it can be unit-tested.
(function () {
    // Convert a string to a Uint8Array using Latin-1 encoding (1 byte per char).
    // Used for building raw PDF binary content where each char maps to one byte.
    function strToBytes(str) {
        const arr = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) {
            arr[i] = str.charCodeAt(i) & 0xFF;
        }
        return arr;
    }

    // Calculate total byte length of already-built parts plus the current
    // text buffer. Used to track PDF object byte offsets for the xref table.
    function byteLength(parts, currentText) {
        return parts.reduce((sum, p) => sum + p.length, 0) + currentText.length;
    }

    function buildPdf(images) {
        let objects = [];
        let objOffsets = [];

        // Helper to add an object and return its 1-based index.
        // PDF objects are numbered starting at 1 (object 0 is the "free" entry).
        function addObj(content) {
            const idx = objects.length + 1;
            objects.push(content);
            return idx;
        }

        // Catalog and Pages are the root of the PDF object tree.
        // They reference each other, so we create placeholders first
        // and fill them in after all page objects are built.
        const catalogIdx = addObj(null); // placeholder - filled after loop
        const pagesIdx = addObj(null);   // placeholder - filled after loop

        // Build one page + image XObject per JPEG image
        const pageRefs = [];

        for (let i = 0; i < images.length; i++) {
            const img = images[i];

            // Page is exactly the image size (no margins, no scaling)
            const pageW = img.width;
            const pageH = img.height;

            // Image XObject
            const imgIdx = addObj({
                type: 'image',
                width: img.width,
                height: img.height,
                data: img.data
            });

            // Content stream: place image at origin, full size
            const contentStream = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im${imgIdx} Do Q`;
            const contentIdx = addObj({ type: 'stream', content: contentStream });

            // Page object
            const pageIdx = addObj({
                type: 'page',
                parent: pagesIdx,
                width: pageW,
                height: pageH,
                contents: contentIdx,
                image: imgIdx
            });

            pageRefs.push(pageIdx);
        }

        // Now fill in catalog and pages
        objects[catalogIdx - 1] = { type: 'catalog', pages: pagesIdx };
        objects[pagesIdx - 1] = { type: 'pages', kids: pageRefs };

        // Serialize all objects to a byte stream.
        // PDF mixes text (object headers, xref) with binary data (JPEG streams).
        // We accumulate text in `currentText` and flush to `parts` (Uint8Array[])
        // whenever we need to insert raw binary data (JPEG bytes).
        let parts = [];
        let currentText = '%PDF-1.4\n%\xFF\xFF\xFF\xFF\n'; // Binary comment marks file as binary for parsers
        objOffsets = [];

        for (let i = 0; i < objects.length; i++) {
            objOffsets.push(byteLength(parts, currentText));
            const obj = objects[i];
            const idx = i + 1;

            if (obj.type === 'catalog') {
                currentText += `${idx} 0 obj\n<< /Type /Catalog /Pages ${obj.pages} 0 R >>\nendobj\n`;
            } else if (obj.type === 'pages') {
                const kids = obj.kids.map(k => `${k} 0 R`).join(' ');
                currentText += `${idx} 0 obj\n<< /Type /Pages /Kids [ ${kids} ] /Count ${obj.kids.length} >>\nendobj\n`;
            } else if (obj.type === 'page') {
                currentText += `${idx} 0 obj\n<< /Type /Page /Parent ${obj.parent} 0 R /MediaBox [0 0 ${obj.width} ${obj.height}] /Contents ${obj.contents} 0 R /Resources << /XObject << /Im${obj.image} ${obj.image} 0 R >> >> >>\nendobj\n`;
            } else if (obj.type === 'stream') {
                const len = obj.content.length;
                currentText += `${idx} 0 obj\n<< /Length ${len} >>\nstream\n${obj.content}\nendstream\nendobj\n`;
            } else if (obj.type === 'image') {
                const imgLen = obj.data.length;
                currentText += `${idx} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${obj.width} /Height ${obj.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgLen} >>\nstream\n`;
                parts.push(strToBytes(currentText));
                parts.push(obj.data);
                currentText = '\nendstream\nendobj\n';
            }
        }

        // Cross-reference table
        const xrefOffset = byteLength(parts, currentText);
        currentText += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
        for (let i = 0; i < objOffsets.length; i++) {
            currentText += objOffsets[i].toString().padStart(10, '0') + ' 00000 n \n';
        }

        // Trailer
        currentText += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogIdx} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
        parts.push(strToBytes(currentText));

        // Concatenate all parts
        const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const part of parts) {
            result.set(part, offset);
            offset += part.length;
        }

        return result;
    }

    window.PdfBuilder = { buildPdf };
})();
