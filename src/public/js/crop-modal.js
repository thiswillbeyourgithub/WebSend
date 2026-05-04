/**
 * Shared crop modal for perspective correction.
 * Used by both send.html (camera capture / gallery edit) and receive.html
 * (annotating already-received images).
 *
 * Extracted from ~450 LOC duplicated across the two HTMLs (PLAN.md item 3).
 *
 * Exposes window.CropModal.open(opts):
 *   opts.sourceBlob      — Blob of the image to crop (required)
 *   opts.initialCorners  — {tl,tr,br,bl} with normalized [0..1] x/y, optional
 *   opts.detectCorners   — (imgElement) => corners|null, optional one-shot fallback
 *                          used when initialCorners is not provided
 *   opts.onApply         — async (resultBlob, normalizedCorners) => void
 *   opts.onCancel        — () => void, optional
 *
 * Depends on window.ImageTransforms.{perspectiveTransform, distance}.
 */
(function () {
    const DEFAULT_CORNERS = {
        tl: { x: 0.05, y: 0.05 },
        tr: { x: 0.95, y: 0.05 },
        br: { x: 0.95, y: 0.95 },
        bl: { x: 0.05, y: 0.95 }
    };

    let initialized = false;
    let state = null;

    function injectTemplate() {
        if (document.getElementById('crop-modal')) { initialized = true; return; }
        const wrap = document.createElement('div');
        wrap.id = 'crop-modal';
        wrap.className = 'crop-modal hidden';
        wrap.innerHTML = `
            <div class="crop-modal-header">
                <h2 data-i18n="crop.title">Crop Document</h2>
                <p data-i18n="crop.instructions">Drag the corners to mark the document edges</p>
            </div>
            <div class="crop-canvas-container" id="crop-container">
                <img id="crop-image" alt="Image to crop">
                <svg class="crop-overlay" id="crop-overlay">
                    <polygon id="crop-polygon" points="0,0 0,0 0,0 0,0"/>
                </svg>
                <div class="crop-handle" id="handle-tl" data-corner="tl"></div>
                <div class="crop-handle" id="handle-tr" data-corner="tr"></div>
                <div class="crop-handle" id="handle-br" data-corner="br"></div>
                <div class="crop-handle" id="handle-bl" data-corner="bl"></div>
                <div class="crop-magnifier hidden" id="crop-magnifier">
                    <canvas id="crop-magnifier-canvas" width="120" height="120"></canvas>
                    <div class="crop-magnifier-crosshair"></div>
                </div>
            </div>
            <div class="crop-buttons">
                <button class="crop-btn-cancel" type="button" data-crop-action="cancel" data-i18n="crop.cancel">Cancel</button>
                <button class="crop-btn-apply" type="button" data-crop-action="apply" data-i18n="crop.apply">Apply Crop</button>
            </div>
        `;
        document.body.appendChild(wrap);

        wrap.querySelector('[data-crop-action="cancel"]').addEventListener('click', cancel);
        wrap.querySelector('[data-crop-action="apply"]').addEventListener('click', apply);

        if (window.i18n && typeof window.i18n.applyTranslations === 'function') {
            try { window.i18n.applyTranslations(); } catch (_) { /* i18n not ready; labels fall back to defaults */ }
        }

        initialized = true;
    }

    function normalizeCorners(corners) {
        const pts = [corners.tl, corners.tr, corners.br, corners.bl];
        pts.sort((a, b) => a.y - b.y || a.x - b.x);
        const top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
        const bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x);
        return { tl: top[0], tr: top[1], bl: bottom[0], br: bottom[1] };
    }

    function updateOverlay() {
        const w = state.imgWidth;
        const h = state.imgHeight;
        const c = state.corners;
        document.getElementById('handle-tl').style.left = (c.tl.x * 100) + '%';
        document.getElementById('handle-tl').style.top = (c.tl.y * 100) + '%';
        document.getElementById('handle-tr').style.left = (c.tr.x * 100) + '%';
        document.getElementById('handle-tr').style.top = (c.tr.y * 100) + '%';
        document.getElementById('handle-br').style.left = (c.br.x * 100) + '%';
        document.getElementById('handle-br').style.top = (c.br.y * 100) + '%';
        document.getElementById('handle-bl').style.left = (c.bl.x * 100) + '%';
        document.getElementById('handle-bl').style.top = (c.bl.y * 100) + '%';
        const polygon = document.getElementById('crop-polygon');
        const points = [
            `${c.tl.x * w},${c.tl.y * h}`,
            `${c.tr.x * w},${c.tr.y * h}`,
            `${c.br.x * w},${c.br.y * h}`,
            `${c.bl.x * w},${c.bl.y * h}`
        ].join(' ');
        polygon.setAttribute('points', points);
    }

    function updateMagnifier(x, y) {
        const magnifier = document.getElementById('crop-magnifier');
        const canvas = document.getElementById('crop-magnifier-canvas');
        const ctx = canvas.getContext('2d');
        const img = state.fullResImg;
        if (!img || !img.naturalWidth) { magnifier.classList.add('hidden'); return; }
        magnifier.classList.remove('hidden');
        const offset = 70;
        const magX = x * 100;
        const magY = y * 100;
        const yOffsetPx = y < 0.2 ? offset : -offset;
        const xOffsetPx = x < 0.2 ? offset : -offset;
        magnifier.style.left = `calc(${magX}% + ${xOffsetPx}px)`;
        magnifier.style.top = `calc(${magY}% + ${yOffsetPx}px)`;
        const zoomFactor = 1.2;
        const canvasSize = canvas.width;
        const srcSize = canvasSize / zoomFactor;
        const srcX = x * img.naturalWidth - srcSize / 2;
        const srcY = y * img.naturalHeight - srcSize / 2;
        ctx.clearRect(0, 0, canvasSize, canvasSize);
        ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, canvasSize, canvasSize);
    }

    function onDrag(e) {
        if (!state || !state.dragging) return;
        e.preventDefault();
        const rect = document.getElementById('crop-container').getBoundingClientRect();
        let clientX, clientY;
        if (e.touches) { clientX = e.touches[0].clientX; clientY = e.touches[0].clientY; }
        else { clientX = e.clientX; clientY = e.clientY; }
        const rawX = (clientX - rect.left) / rect.width + (state.dragOffsetX || 0);
        const rawY = (clientY - rect.top) / rect.height + (state.dragOffsetY || 0);
        const x = Math.max(0, Math.min(1, rawX));
        const y = Math.max(0, Math.min(1, rawY));
        state.corners[state.dragging] = { x, y };
        updateOverlay();
        updateMagnifier(x, y);
    }

    function onDragEnd() {
        if (!state) return;
        state.dragging = null;
        const mag = document.getElementById('crop-magnifier');
        if (mag) mag.classList.add('hidden');
    }

    function setupHandles() {
        const handles = ['tl', 'tr', 'br', 'bl'];
        const container = document.getElementById('crop-container');

        handles.forEach(corner => {
            const handle = document.getElementById(`handle-${corner}`);
            const onHandleStart = (e) => {
                e.preventDefault();
                state.dragging = corner;
                state.dragOffsetX = 0;
                state.dragOffsetY = 0;
                updateMagnifier(state.corners[corner].x, state.corners[corner].y);
            };
            handle.addEventListener('mousedown', onHandleStart);
            handle.addEventListener('touchstart', onHandleStart, { passive: false });
            state.handleListeners.push({ el: handle, evt: 'mousedown', fn: onHandleStart });
            state.handleListeners.push({ el: handle, evt: 'touchstart', fn: onHandleStart });
        });

        const startNearestCorner = (e) => {
            if (e.target.classList.contains('crop-handle')) return;
            e.preventDefault();
            const rect = container.getBoundingClientRect();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const x = (clientX - rect.left) / rect.width;
            const y = (clientY - rect.top) / rect.height;
            let closest = null, minDist = Infinity;
            for (const c of handles) {
                const dx = state.corners[c].x - x;
                const dy = state.corners[c].y - y;
                const d = dx * dx + dy * dy;
                if (d < minDist) { minDist = d; closest = c; }
            }
            state.dragging = closest;
            state.dragOffsetX = state.corners[closest].x - x;
            state.dragOffsetY = state.corners[closest].y - y;
            updateMagnifier(state.corners[closest].x, state.corners[closest].y);
        };
        container.addEventListener('mousedown', startNearestCorner);
        container.addEventListener('touchstart', startNearestCorner, { passive: false });
        state.handleListeners.push({ el: container, evt: 'mousedown', fn: startNearestCorner });
        state.handleListeners.push({ el: container, evt: 'touchstart', fn: startNearestCorner });

        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', onDragEnd);
        document.addEventListener('touchmove', onDrag, { passive: false });
        document.addEventListener('touchend', onDragEnd);
    }

    function teardownHandles() {
        if (!state) return;
        for (const l of state.handleListeners) {
            l.el.removeEventListener(l.evt, l.fn);
        }
        state.handleListeners = [];
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', onDragEnd);
        document.removeEventListener('touchmove', onDrag);
        document.removeEventListener('touchend', onDragEnd);
    }

    function hide() {
        if (!state) return;
        teardownHandles();
        document.getElementById('crop-modal').classList.add('hidden');
        document.getElementById('crop-magnifier').classList.add('hidden');
        if (state.originalUrl && state.originalUrl.startsWith('blob:')) {
            URL.revokeObjectURL(state.originalUrl);
        }
        state = null;
    }

    function cancel() {
        if (!state) return;
        const cb = state.onCancel;
        hide();
        if (typeof cb === 'function') {
            try { cb(); } catch (e) { /* swallow — caller reported */ }
        }
    }

    async function apply() {
        if (!state) return;
        const { onApply, originalUrl, corners } = state;
        try {
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = originalUrl;
            });

            const c = normalizeCorners(corners);
            const srcW = img.width;
            const srcH = img.height;
            const srcCorners = [
                { x: c.tl.x * srcW, y: c.tl.y * srcH },
                { x: c.tr.x * srcW, y: c.tr.y * srcH },
                { x: c.br.x * srcW, y: c.br.y * srcH },
                { x: c.bl.x * srcW, y: c.bl.y * srcH }
            ];
            const { perspectiveTransform, distance } = window.ImageTransforms;
            const topWidth = distance(srcCorners[0], srcCorners[1]);
            const bottomWidth = distance(srcCorners[3], srcCorners[2]);
            const leftHeight = distance(srcCorners[0], srcCorners[3]);
            const rightHeight = distance(srcCorners[1], srcCorners[2]);
            const dstW = Math.round(Math.max(topWidth, bottomWidth));
            const dstH = Math.round(Math.max(leftHeight, rightHeight));

            const resultCanvas = perspectiveTransform(img, srcCorners, dstW, dstH);
            const resultBlob = await new Promise(resolve => resultCanvas.toBlob(resolve, 'image/jpeg', 0.92));
            const normalized = { tl: { ...c.tl }, tr: { ...c.tr }, br: { ...c.br }, bl: { ...c.bl } };
            const cb = onApply;
            hide();
            if (typeof cb === 'function') {
                await cb(resultBlob, normalized, { dstW, dstH });
            }
        } catch (e) {
            hide();
            if (window.logger) window.logger.error('Crop failed: ' + e.message);
            if (typeof window.showToast === 'function') window.showToast('Crop failed: ' + e.message);
        }
    }

    function open(opts) {
        if (!opts || !opts.sourceBlob) throw new Error('CropModal.open requires sourceBlob');
        if (!window.ImageTransforms) throw new Error('CropModal requires window.ImageTransforms');
        injectTemplate();

        if (state) hide();

        state = {
            originalUrl: URL.createObjectURL(opts.sourceBlob),
            imgWidth: 0,
            imgHeight: 0,
            corners: opts.initialCorners
                ? { tl: { ...opts.initialCorners.tl }, tr: { ...opts.initialCorners.tr },
                    br: { ...opts.initialCorners.br }, bl: { ...opts.initialCorners.bl } }
                : { ...DEFAULT_CORNERS, tl: { ...DEFAULT_CORNERS.tl }, tr: { ...DEFAULT_CORNERS.tr },
                    br: { ...DEFAULT_CORNERS.br }, bl: { ...DEFAULT_CORNERS.bl } },
            dragging: null,
            dragOffsetX: 0,
            dragOffsetY: 0,
            fullResImg: null,
            onApply: opts.onApply,
            onCancel: opts.onCancel,
            handleListeners: [],
            hasInitialCorners: !!opts.initialCorners
        };

        const cropImg = document.getElementById('crop-image');
        cropImg.onload = () => {
            if (!state) return;
            state.imgWidth = cropImg.clientWidth;
            state.imgHeight = cropImg.clientHeight;

            if (!state.hasInitialCorners && typeof opts.detectCorners === 'function') {
                try {
                    const detected = opts.detectCorners(cropImg);
                    if (detected) {
                        state.corners = {
                            tl: { ...detected.tl },
                            tr: { ...detected.tr },
                            br: { ...detected.br },
                            bl: { ...detected.bl }
                        };
                    }
                } catch (_) { /* detection is best-effort */ }
            }

            updateOverlay();

            const fullImg = new Image();
            fullImg.src = state.originalUrl;
            state.fullResImg = fullImg;
        };
        cropImg.src = state.originalUrl;

        document.getElementById('crop-modal').classList.remove('hidden');
        setupHandles();
    }

    window.CropModal = { open, normalizeCorners };
})();
