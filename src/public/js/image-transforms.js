/**
 * Shared image-transform utilities.
 * Extracted from the inline scripts in receive.html and send.html to avoid
 * duplication and make the functions unit-testable.
 *
 * Exposes window.ImageTransforms = {
 *   applyOtsu, perspectiveTransform, distance,
 *   rotateImage, flipImage, binarize, cropPerspective
 * }
 */
(function () {
/**
 * Apply Otsu's method to binarize an ImageData in place.
 * Converts to grayscale, finds optimal threshold, then sets each pixel
 * to pure black or white via a soft sigmoid transition.
 * @param {ImageData} imageData - Canvas ImageData (modified in place)
 */
function applyOtsu(imageData) {
    const data = imageData.data;
    const len = data.length / 4;

    // Build grayscale histogram (256 bins)
    const histogram = new Uint32Array(256);
    for (let i = 0; i < len; i++) {
        const idx = i * 4;
        // Standard luminance weights (ITU-R BT.601)
        const gray = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
        histogram[gray]++;
    }

    // Otsu's method: find threshold that maximizes inter-class variance
    let totalSum = 0;
    for (let i = 0; i < 256; i++) totalSum += i * histogram[i];

    let bgCount = 0, bgSum = 0;
    let bestThreshold = 0, bestVariance = 0;

    for (let t = 0; t < 256; t++) {
        bgCount += histogram[t];
        if (bgCount === 0) continue;
        const fgCount = len - bgCount;
        if (fgCount === 0) break;

        bgSum += t * histogram[t];
        const bgMean = bgSum / bgCount;
        const fgMean = (totalSum - bgSum) / fgCount;
        const diff = bgMean - fgMean;
        const variance = bgCount * fgCount * diff * diff;

        if (variance > bestVariance) {
            bestVariance = variance;
            bestThreshold = t;
        }
    }

    // Soft sigmoid transition: pixels far from threshold become pure black/white;
    // those near it get intermediate values for smoother lettering.
    const sharpness = 0.15; // lower = softer (range ~0.05–0.5)
    for (let i = 0; i < len; i++) {
        const idx = i * 4;
        const gray = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
        const val = Math.round(255 / (1 + Math.exp(-sharpness * (gray - bestThreshold))));
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
        // Alpha channel left unchanged
    }
}

/**
 * Perform perspective transform using inverse mapping with bilinear interpolation.
 * Computes a 3x3 homography matrix (DLT) from the 4 source corners.
 * @param {HTMLImageElement|HTMLCanvasElement} srcImg - Source image
 * @param {Array<{x,y}>} srcCorners - 4 source corners [TL,TR,BR,BL]
 * @param {number} dstW - Output width
 * @param {number} dstH - Output height
 * @returns {HTMLCanvasElement} Transformed canvas
 */
function perspectiveTransform(srcImg, srcCorners, dstW, dstH) {
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = srcImg.width;
    srcCanvas.height = srcImg.height;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(srcImg, 0, 0);
    const srcData = srcCtx.getImageData(0, 0, srcImg.width, srcImg.height);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = dstW;
    dstCanvas.height = dstH;
    const dstCtx = dstCanvas.getContext('2d');
    const dstData = dstCtx.createImageData(dstW, dstH);

    const dstCorners = [
        { x: 0,    y: 0    },
        { x: dstW, y: 0    },
        { x: dstW, y: dstH },
        { x: 0,    y: dstH }
    ];

    // Inverse homography: maps dst coords back to src coords
    const H = _computeHomography(dstCorners, srcCorners);

    for (let y = 0; y < dstH; y++) {
        for (let x = 0; x < dstW; x++) {
            const srcPt = _applyHomography(H, x, y);
            const color = _bilinearSample(srcData, srcPt.x, srcPt.y);
            const dstIdx = (y * dstW + x) * 4;
            dstData.data[dstIdx]     = color.r;
            dstData.data[dstIdx + 1] = color.g;
            dstData.data[dstIdx + 2] = color.b;
            dstData.data[dstIdx + 3] = 255;
        }
    }

    dstCtx.putImageData(dstData, 0, 0);
    return dstCanvas;
}

/** Euclidean distance between two {x,y} points */
function distance(p1, p2) {
    return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
}

// ---- private helpers ----

function _computeHomography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
        const sx = src[i].x, sy = src[i].y;
        const dx = dst[i].x, dy = dst[i].y;
        A.push([-sx, -sy, -1, 0, 0, 0, sx * dx, sy * dx, dx]);
        A.push([0, 0, 0, -sx, -sy, -1, sx * dy, sy * dy, dy]);
    }
    const h = _solveHomography(A);
    return [
        [h[0], h[1], h[2]],
        [h[3], h[4], h[5]],
        [h[6], h[7], 1]
    ];
}

function _solveHomography(A) {
    const n = 8;
    const M = [];
    const b = [];
    for (let i = 0; i < n; i++) {
        M.push(A[i].slice(0, 8));
        b.push(-A[i][8]);
    }

    // Gaussian elimination with partial pivoting
    for (let col = 0; col < n; col++) {
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
        }
        [M[col], M[maxRow]] = [M[maxRow], M[col]];
        [b[col], b[maxRow]] = [b[maxRow], b[col]];

        for (let row = col + 1; row < n; row++) {
            const factor = M[row][col] / M[col][col];
            for (let j = col; j < n; j++) M[row][j] -= factor * M[col][j];
            b[row] -= factor * b[col];
        }
    }

    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        x[i] = b[i];
        for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
        x[i] /= M[i][i];
    }
    return x;
}

function _applyHomography(H, x, y) {
    const w = H[2][0] * x + H[2][1] * y + H[2][2];
    return {
        x: (H[0][0] * x + H[0][1] * y + H[0][2]) / w,
        y: (H[1][0] * x + H[1][1] * y + H[1][2]) / w
    };
}

function _bilinearSample(imgData, x, y) {
    const w = imgData.width;
    const h = imgData.height;
    const data = imgData.data;

    x = Math.max(0, Math.min(w - 1.001, x));
    y = Math.max(0, Math.min(h - 1.001, y));

    const x0 = Math.floor(x), x1 = Math.min(x0 + 1, w - 1);
    const y0 = Math.floor(y), y1 = Math.min(y0 + 1, h - 1);
    const xf = x - x0, yf = y - y0;

    const idx00 = (y0 * w + x0) * 4;
    const idx10 = (y0 * w + x1) * 4;
    const idx01 = (y1 * w + x0) * 4;
    const idx11 = (y1 * w + x1) * 4;

    const lerp = (a, b, t) => a + (b - a) * t;
    return {
        r: lerp(lerp(data[idx00],     data[idx10],     xf), lerp(data[idx01],     data[idx11],     xf), yf),
        g: lerp(lerp(data[idx00 + 1], data[idx10 + 1], xf), lerp(data[idx01 + 1], data[idx11 + 1], xf), yf),
        b: lerp(lerp(data[idx00 + 2], data[idx10 + 2], xf), lerp(data[idx01 + 2], data[idx11 + 2], xf), yf)
    };
}

// ---- canvas-pipeline helpers (blob → image → canvas → operate → bytes) ----

/**
 * Normalize input to a Blob. Accepts a Blob or {data, mimeType}.
 */
function _toBlob(input) {
    if (input instanceof Blob) return input;
    return new Blob([input.data], { type: input.mimeType });
}

/**
 * Load input into an ImageBitmap. Caller is responsible for .close()ing it.
 */
async function _loadBitmap(input) {
    return await createImageBitmap(_toBlob(input));
}

/**
 * Encode a canvas to {data: Uint8Array, mimeType}.
 */
async function _canvasToBytes(canvas, mimeType, quality) {
    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), mimeType, quality);
    });
    const buf = await blob.arrayBuffer();
    return { data: new Uint8Array(buf), mimeType };
}

/**
 * Rotate by `degrees` (multiples of 90) and re-encode as JPEG @0.95.
 * @param {Blob|{data,mimeType}} input
 * @param {{degrees?: number}} [opts]
 * @returns {Promise<{data: Uint8Array, mimeType: string}>}
 */
async function rotateImage(input, opts) {
    const degrees = (opts && opts.degrees) || 90;
    const bitmap = await _loadBitmap(input);
    const canvas = document.createElement('canvas');
    const swap = degrees % 180 !== 0;
    canvas.width = swap ? bitmap.height : bitmap.width;
    canvas.height = swap ? bitmap.width : bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    bitmap.close();
    return _canvasToBytes(canvas, 'image/jpeg', 0.95);
}

/**
 * Flip horizontally (axis: 'h') or vertically (axis: 'v'). JPEG @0.95.
 */
async function flipImage(input, opts) {
    const axis = (opts && opts.axis) || 'h';
    const bitmap = await _loadBitmap(input);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (axis === 'h') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
    } else {
        ctx.translate(0, canvas.height);
        ctx.scale(1, -1);
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return _canvasToBytes(canvas, 'image/jpeg', 0.95);
}

/**
 * Apply Otsu B&W binarization, output PNG (lossless after thresholding).
 */
async function binarize(input) {
    const bitmap = await _loadBitmap(input);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyOtsu(imageData);
    ctx.putImageData(imageData, 0, 0);
    return _canvasToBytes(canvas, 'image/png');
}

/**
 * Perspective-crop using normalized corner coordinates (each in [0,1]).
 * Output dimensions are derived from the longer of the parallel edges.
 * JPEG @0.92.
 * @param {Blob|{data,mimeType}} input
 * @param {{corners: {tl,tr,br,bl}}} opts - corners as {x,y} normalized to [0,1]
 */
async function cropPerspective(input, opts) {
    // perspectiveTransform needs an HTMLImageElement (drawImage source for getImageData).
    const blob = _toBlob(input);
    const url = URL.createObjectURL(blob);
    try {
        const imgEl = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('Image load failed'));
            im.src = url;
        });
        const c = opts.corners;
        const srcW = imgEl.width;
        const srcH = imgEl.height;
        const srcCorners = [
            { x: c.tl.x * srcW, y: c.tl.y * srcH },
            { x: c.tr.x * srcW, y: c.tr.y * srcH },
            { x: c.br.x * srcW, y: c.br.y * srcH },
            { x: c.bl.x * srcW, y: c.bl.y * srcH }
        ];
        const topW = distance(srcCorners[0], srcCorners[1]);
        const botW = distance(srcCorners[3], srcCorners[2]);
        const leftH = distance(srcCorners[0], srcCorners[3]);
        const rightH = distance(srcCorners[1], srcCorners[2]);
        const dstW = Math.round(Math.max(topW, botW));
        const dstH = Math.round(Math.max(leftH, rightH));
        const resultCanvas = perspectiveTransform(imgEl, srcCorners, dstW, dstH);
        return _canvasToBytes(resultCanvas, 'image/jpeg', 0.92);
    } finally {
        URL.revokeObjectURL(url);
    }
}

window.ImageTransforms = {
    applyOtsu, perspectiveTransform, distance,
    rotateImage, flipImage, binarize, cropPerspective
};
})();
