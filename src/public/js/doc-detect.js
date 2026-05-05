/**
 * DocDetect — Pure JS document edge detection for WebSend.
 * Detects the largest quadrilateral (document/page) in an image or video frame.
 *
 * Algorithm: downscale → grayscale → blur → Sobel edges → Otsu threshold →
 *            contour tracing → Douglas-Peucker simplification → largest convex quad.
 *
 * Built with Claude Code.
 *
 * @global DocDetect
 */

const DocDetect = (function () {
    'use strict';

    const TARGET_WIDTH = 400; // Downscale target — higher for better edge detection

    /**
     * Detect document edges from a video element.
     * @param {HTMLVideoElement} video
     * @returns {{ tl: {x,y}, tr: {x,y}, br: {x,y}, bl: {x,y} } | null}
     */
    function detectFromVideo(video) {
        if (!video.videoWidth || !video.videoHeight) return null;
        const scale = TARGET_WIDTH / video.videoWidth;
        const w = TARGET_WIDTH;
        const h = Math.round(video.videoHeight * scale);
        const c = _getOffscreenCanvas(w, h);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, w, h);
        return _detectFromContext(ctx, w, h);
    }

    /**
     * Detect document edges from a canvas element.
     * @param {HTMLCanvasElement} canvas
     * @returns {{ tl: {x,y}, tr: {x,y}, br: {x,y}, bl: {x,y} } | null}
     */
    function detectFromCanvas(canvas) {
        const scale = TARGET_WIDTH / canvas.width;
        const w = TARGET_WIDTH;
        const h = Math.round(canvas.height * scale);
        const c = _getOffscreenCanvas(w, h);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0, w, h);
        return _detectFromContext(ctx, w, h);
    }

    /**
     * Detect document edges from an Image element.
     * @param {HTMLImageElement} img
     * @returns {{ tl: {x,y}, tr: {x,y}, br: {x,y}, bl: {x,y} } | null}
     */
    function detectFromImage(img) {
        if (!img.naturalWidth || !img.naturalHeight) return null;
        const scale = TARGET_WIDTH / img.naturalWidth;
        const w = TARGET_WIDTH;
        const h = Math.round(img.naturalHeight * scale);
        const c = _getOffscreenCanvas(w, h);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        return _detectFromContext(ctx, w, h);
    }

    // Reusable offscreen canvas
    let _offCanvas = null;
    function _getOffscreenCanvas(w, h) {
        if (!_offCanvas) _offCanvas = document.createElement('canvas');
        _offCanvas.width = w;
        _offCanvas.height = h;
        return _offCanvas;
    }

    /**
     * Core detection pipeline.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} w
     * @param {number} h
     * @returns {{ tl: {x,y}, tr: {x,y}, br: {x,y}, bl: {x,y} } | null}
     */
    function _detectFromContext(ctx, w, h) {
        const imgData = ctx.getImageData(0, 0, w, h);
        const src = imgData.data;

        // 1. Grayscale
        const gray = new Uint8Array(w * h);
        for (let i = 0; i < gray.length; i++) {
            const p = i * 4;
            gray[i] = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
        }

        // 2. Gaussian blur 5x5
        const blurred = _gaussianBlur5(gray, w, h);

        // 3. Sobel edge detection
        const edges = _sobelEdges(blurred, w, h);

        // 4. Otsu threshold on edge magnitudes (use 60% of Otsu for higher sensitivity)
        const threshold = Math.max(_otsuThreshold(edges) * 0.6, 10);
        const binary = new Uint8Array(w * h);
        for (let i = 0; i < edges.length; i++) {
            binary[i] = edges[i] >= threshold ? 1 : 0;
        }

        // 5. Suppress edges near the four image corners (diagonal strips)
        // Paper curling at corners creates false edges that distort the detected quad
        const cornerRadius = Math.round(Math.min(w, h) * 0.12);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                // Distance from each image corner
                const dTL = Math.max(cornerRadius - x, 0) + Math.max(cornerRadius - y, 0);
                const dTR = Math.max(x - (w - 1 - cornerRadius), 0) + Math.max(cornerRadius - y, 0);
                const dBL = Math.max(cornerRadius - x, 0) + Math.max(y - (h - 1 - cornerRadius), 0);
                const dBR = Math.max(x - (w - 1 - cornerRadius), 0) + Math.max(y - (h - 1 - cornerRadius), 0);
                if (dTL > cornerRadius * 0.5 || dTR > cornerRadius * 0.5 ||
                    dBL > cornerRadius * 0.5 || dBR > cornerRadius * 0.5) {
                    binary[y * w + x] = 0;
                }
            }
        }

        // 6. Dilate to close gaps in edges
        let dilated = binary;
        for (let i = 0; i < 5; i++) dilated = _dilate(dilated, w, h);

        // 7. Flood-fill from image borders to find background, then extract foreground
        const foreground = _extractForeground(dilated, w, h);

        // 8. Find contours of the foreground (document) region
        const contours = _findContours(foreground, w, h);

        // 9. Find largest quad
        const quad = _findLargestQuad(contours, w, h);
        if (!quad) return null;

        // 10. Normalize to 0-1 and sort corners
        return _sortCorners(quad.map(p => ({ x: p.x / w, y: p.y / h })));
    }

    /** 5x5 Gaussian blur (sigma ≈ 1.0) */
    function _gaussianBlur5(gray, w, h) {
        // Separable 1D kernel: [1, 4, 6, 4, 1] / 16
        const k = [1, 4, 6, 4, 1];
        const kSum = 16;
        const temp = new Uint8Array(w * h);
        const out = new Uint8Array(w * h);

        // Horizontal pass
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let sum = 0;
                for (let i = -2; i <= 2; i++) {
                    const cx = Math.min(Math.max(x + i, 0), w - 1);
                    sum += gray[y * w + cx] * k[i + 2];
                }
                temp[y * w + x] = (sum / kSum) | 0;
            }
        }
        // Vertical pass
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let sum = 0;
                for (let i = -2; i <= 2; i++) {
                    const cy = Math.min(Math.max(y + i, 0), h - 1);
                    sum += temp[cy * w + x] * k[i + 2];
                }
                out[y * w + x] = (sum / kSum) | 0;
            }
        }
        return out;
    }

    /** Sobel edge magnitude (Manhattan: |Gx| + |Gy|) */
    function _sobelEdges(gray, w, h) {
        const mag = new Uint16Array(w * h);
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const i = y * w + x;
                const tl = gray[i - w - 1], tc = gray[i - w], tr = gray[i - w + 1];
                const ml = gray[i - 1],                        mr = gray[i + 1];
                const bl = gray[i + w - 1], bc = gray[i + w], br = gray[i + w + 1];
                const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
                const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
                mag[i] = Math.abs(gx) + Math.abs(gy);
            }
        }
        return mag;
    }

    /** Otsu's threshold for a Uint16Array (edge magnitudes) */
    function _otsuThreshold(data) {
        // Build histogram (clamp to 0-511 range for edge magnitudes)
        const maxBin = 512;
        const hist = new Uint32Array(maxBin);
        for (let i = 0; i < data.length; i++) {
            hist[Math.min(data[i], maxBin - 1)]++;
        }
        const total = data.length;
        let sum = 0;
        for (let i = 0; i < maxBin; i++) sum += i * hist[i];

        let sumB = 0, wB = 0, maxVar = 0, threshold = 0;
        for (let i = 0; i < maxBin; i++) {
            wB += hist[i];
            if (wB === 0) continue;
            const wF = total - wB;
            if (wF === 0) break;
            sumB += i * hist[i];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            const v = wB * wF * (mB - mF) * (mB - mF);
            if (v > maxVar) { maxVar = v; threshold = i; }
        }
        return threshold;
    }

    /** 3x3 dilation on binary image */
    function _dilate(binary, w, h) {
        const out = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const i = y * w + x;
                if (binary[i] || binary[i - 1] || binary[i + 1] ||
                    binary[i - w] || binary[i + w] ||
                    binary[i - w - 1] || binary[i - w + 1] ||
                    binary[i + w - 1] || binary[i + w + 1]) {
                    out[i] = 1;
                }
            }
        }
        return out;
    }

    /**
     * Flood-fill from image borders through non-edge pixels to identify background.
     * Everything not reachable from the border is foreground (the document).
     */
    function _extractForeground(edges, w, h) {
        // 0 = unvisited, 1 = background (reachable from border)
        const bg = new Uint8Array(w * h);
        const stack = [];

        // Seed from all border pixels that are NOT edge pixels
        for (let x = 0; x < w; x++) {
            if (!edges[x]) stack.push(x);                       // top row
            if (!edges[(h - 1) * w + x]) stack.push((h - 1) * w + x); // bottom row
        }
        for (let y = 1; y < h - 1; y++) {
            if (!edges[y * w]) stack.push(y * w);               // left col
            if (!edges[y * w + w - 1]) stack.push(y * w + w - 1); // right col
        }

        // Mark seeds
        for (const idx of stack) bg[idx] = 1;

        // BFS flood fill
        while (stack.length > 0) {
            const idx = stack.pop();
            const x = idx % w, y = (idx - x) / w;
            const neighbors = [
                idx - 1, idx + 1, idx - w, idx + w // 4-connectivity
            ];
            for (const ni of neighbors) {
                if (ni >= 0 && ni < w * h && !bg[ni] && !edges[ni]) {
                    // For left/right neighbors, ensure we don't wrap rows
                    const nx = ni % w;
                    if (Math.abs(nx - x) > 1) continue;
                    bg[ni] = 1;
                    stack.push(ni);
                }
            }
        }

        // Foreground = anything not background and not too close to border
        const fg = new Uint8Array(w * h);
        for (let y = 2; y < h - 2; y++) {
            for (let x = 2; x < w - 2; x++) {
                const i = y * w + x;
                if (!bg[i]) fg[i] = 1;
            }
        }
        return fg;
    }

    /**
     * Simple contour tracing using Moore boundary tracing.
     * Returns arrays of {x, y} points for each contour.
     */
    function _findContours(binary, w, h) {
        const visited = new Uint8Array(w * h);
        const contours = [];
        // 8-neighbor directions: right, down-right, down, down-left, left, up-left, up, up-right
        const dx = [1, 1, 0, -1, -1, -1, 0, 1];
        const dy = [0, 1, 1, 1, 0, -1, -1, -1];

        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const i = y * w + x;
                if (!binary[i] || visited[i]) continue;
                // Check if it's a border pixel (has at least one 0-neighbor)
                let isBorder = false;
                for (let d = 0; d < 8; d++) {
                    if (!binary[(y + dy[d]) * w + (x + dx[d])]) { isBorder = true; break; }
                }
                if (!isBorder) continue;

                // Trace contour
                const contour = [];
                let cx = x, cy = y;
                let dir = 0; // Start scanning from "right"
                const startX = x, startY = y;
                let steps = 0;
                const maxSteps = w * h;

                do {
                    contour.push({ x: cx, y: cy });
                    visited[cy * w + cx] = 1;

                    // Find next border pixel by scanning CCW from (dir + 5) % 8
                    let found = false;
                    let startDir = (dir + 5) % 8; // Backtrack direction + 1
                    for (let d = 0; d < 8; d++) {
                        const nd = (startDir + d) % 8;
                        const nx = cx + dx[nd], ny = cy + dy[nd];
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h && binary[ny * w + nx]) {
                            cx = nx;
                            cy = ny;
                            dir = nd;
                            found = true;
                            break;
                        }
                    }
                    if (!found) break;
                    steps++;
                } while ((cx !== startX || cy !== startY) && steps < maxSteps);

                if (contour.length >= 10) {
                    contours.push(contour);
                }
            }
        }
        return contours;
    }

    /**
     * Find the largest convex quadrilateral among detected contours.
     * Uses Douglas-Peucker simplification to reduce contours to polygons.
     */
    function _findLargestQuad(contours, w, h) {
        const minArea = w * h * 0.03; // Quad must be >3% of frame
        let bestQuad = null;
        let bestArea = 0;

        for (const contour of contours) {
            const perimeter = _perimeter(contour);
            // Try multiple epsilon values for Douglas-Peucker
            for (let epsRatio = 0.005; epsRatio <= 0.08; epsRatio += 0.003) {
                const simplified = _douglasPeucker(contour, perimeter * epsRatio);
                // Accept up to 12 vertices: curved sides and folded corners produce
                // extra vertices that DP cannot collapse without losing real corners.
                if (simplified.length >= 4 && simplified.length <= 12) {
                    const quad = simplified.length === 4 ? simplified : _reduceToQuad(simplified);
                    const area = _polygonArea(quad);
                    if (area > minArea && area > bestArea && _isConvex(quad)) {
                        bestArea = area;
                        bestQuad = quad;
                    }
                }
            }
        }
        return bestQuad;
    }

    /** Compute contour perimeter */
    function _perimeter(pts) {
        let p = 0;
        for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
            p += Math.sqrt(dx * dx + dy * dy);
        }
        return p;
    }

    /** Douglas-Peucker line simplification */
    function _douglasPeucker(pts, epsilon) {
        if (pts.length <= 2) return pts.slice();

        // Find the point farthest from the line between first and last
        let maxDist = 0, maxIdx = 0;
        const first = pts[0], last = pts[pts.length - 1];
        for (let i = 1; i < pts.length - 1; i++) {
            const d = _pointLineDistance(pts[i], first, last);
            if (d > maxDist) { maxDist = d; maxIdx = i; }
        }

        if (maxDist > epsilon) {
            const left = _douglasPeucker(pts.slice(0, maxIdx + 1), epsilon);
            const right = _douglasPeucker(pts.slice(maxIdx), epsilon);
            return left.slice(0, -1).concat(right);
        }
        return [first, last];
    }

    /** Perpendicular distance from point to line */
    function _pointLineDistance(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
        const num = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x);
        return num / Math.sqrt(lenSq);
    }

    /** Polygon area using shoelace formula */
    function _polygonArea(pts) {
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        }
        return Math.abs(area) / 2;
    }

    /** Check if polygon is convex */
    function _isConvex(pts) {
        let sign = 0;
        const n = pts.length;
        for (let i = 0; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
            const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
            if (cross !== 0) {
                if (sign === 0) sign = cross > 0 ? 1 : -1;
                else if ((cross > 0 ? 1 : -1) !== sign) return false;
            }
        }
        return true;
    }

    /**
     * Reduce a polygon with 5-6 vertices to the best 4 by iteratively
     * removing the vertex that contributes least area.
     */
    function _reduceToQuad(pts) {
        const arr = pts.slice();
        while (arr.length > 4) {
            let minContrib = Infinity, minIdx = 0;
            for (let i = 0; i < arr.length; i++) {
                const prev = arr[(i - 1 + arr.length) % arr.length];
                const curr = arr[i];
                const next = arr[(i + 1) % arr.length];
                // Triangle area formed by removing this vertex
                const contrib = Math.abs((next.x - prev.x) * (curr.y - prev.y) - (curr.x - prev.x) * (next.y - prev.y)) / 2;
                if (contrib < minContrib) { minContrib = contrib; minIdx = i; }
            }
            arr.splice(minIdx, 1);
        }
        return arr;
    }

    /**
     * Sort 4 points into tl, tr, br, bl order.
     * Uses angle from centroid to assign each point to a unique corner.
     * Returns null if points are degenerate (collinear or near-duplicate).
     */
    function _sortCorners(pts) {
        if (pts.length !== 4) return null;

        // Centroid
        const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
        const cy = pts.reduce((s, p) => s + p.y, 0) / 4;

        // Sort by angle from centroid (atan2), giving clockwise order: tl, tr, br, bl
        const sorted = pts.slice().sort((a, b) => {
            const angA = Math.atan2(a.y - cy, a.x - cx);
            const angB = Math.atan2(b.y - cy, b.x - cx);
            return angA - angB;
        });

        // sorted is in order of increasing angle: starts from ~-PI (left)
        // We need to find which is tl. Angles: tl ~ -3π/4, tr ~ -π/4, br ~ π/4, bl ~ 3π/4
        // Remap: the point with smallest (x+y) is tl — find its index and rotate
        let tlIdx = 0;
        let minSum = Infinity;
        for (let i = 0; i < 4; i++) {
            const s = sorted[i].x + sorted[i].y;
            if (s < minSum) { minSum = s; tlIdx = i; }
        }

        // Rotate so tl is first, then order is tl, bl, br, tr (CCW from atan2)
        // atan2 goes CCW, so after tl comes bl, br, tr
        const r = i => sorted[(tlIdx + i) % 4];
        const result = { tl: r(0), bl: r(1), br: r(2), tr: r(3) };

        // Validate: check all 4 corners are distinct (no triangle/line degeneracy)
        const corners = [result.tl, result.tr, result.br, result.bl];
        for (let i = 0; i < 4; i++) {
            for (let j = i + 1; j < 4; j++) {
                const dx = corners[i].x - corners[j].x;
                const dy = corners[i].y - corners[j].y;
                if (dx * dx + dy * dy < 0.001) return null; // Too close — degenerate
            }
        }

        // Validate: check minimum angle (reject near-collinear quads)
        for (let i = 0; i < 4; i++) {
            const a = corners[i];
            const b = corners[(i + 1) % 4];
            const c = corners[(i + 2) % 4];
            const v1x = a.x - b.x, v1y = a.y - b.y;
            const v2x = c.x - b.x, v2y = c.y - b.y;
            const dot = v1x * v2x + v1y * v2y;
            const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
            const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
            if (len1 < 0.001 || len2 < 0.001) return null;
            const cosAngle = dot / (len1 * len2);
            // Reject if any angle < ~20° or > ~160° (cos > 0.94 or cos < -0.94).
            // Strong perspective skew or a folded corner can push angles past 30°/150°,
            // so we keep the bound loose and rely on convexity + side-ratio checks.
            if (Math.abs(cosAngle) > 0.94) return null;
        }

        // Validate: opposite side length ratio — reject if one side is >4x its opposite
        // (a perspective-transformed rectangle keeps opposite sides within a reasonable ratio)
        const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
        const sideTop = dist(result.tl, result.tr);
        const sideBottom = dist(result.bl, result.br);
        const sideLeft = dist(result.tl, result.bl);
        const sideRight = dist(result.tr, result.br);
        const ratioH = Math.max(sideTop, sideBottom) / (Math.min(sideTop, sideBottom) || 0.001);
        const ratioV = Math.max(sideLeft, sideRight) / (Math.min(sideLeft, sideRight) || 0.001);
        if (ratioH > 4 || ratioV > 4) return null;

        return result;
    }

    return { detectFromVideo, detectFromCanvas, detectFromImage };
})();
