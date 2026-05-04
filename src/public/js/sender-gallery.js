/**
 * sender-gallery.js
 *
 * Genius-Scan-like gallery for the sender page. Manages the list of captured
 * photos (`galleryPhotos`), thumbnail grid, per-photo edit view (rotate, flip,
 * B&W, crop), drag-and-drop reorder, and batch finalization.
 *
 * Cross-page references are wired in via Gallery.attach({...}) once during
 * page init.
 *
 * Exposed as window.Gallery.
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    // -- State --
    let galleryPhotos = [];
    let photoIdCounter = 0;
    let galleryEditIndex = -1;

    // -- Wired-in deps (set by attach) --
    // rtc is accessed via getter because the sender page replaces it on
    // reconnect — caching the reference would leave Gallery pointing at a
    // dead peer connection. The send queue lives in window.SenderSend; we
    // call removeQueuedPhotoById to drop a not-yet-sent photo on delete.
    let _getRtc = null;
    let _i18n = null;
    let _logger = null;
    let _showToast = null;
    let _showStep = null;
    let _stepChoose = null;
    let _stopCapture = null;
    let _openCropModal = null;
    let _getFlashMode = null;
    let _getCaptureStream = null;
    let _setCropContext = null;
    let _removeQueuedPhotoById = null;

    function attach(deps) {
        _getRtc = deps.getRtc;
        _i18n = deps.i18n;
        _logger = deps.logger;
        _showToast = deps.showToast;
        _showStep = deps.showStep;
        _stepChoose = deps.stepChoose;
        _stopCapture = deps.stopCapture;
        _openCropModal = deps.openCropModal;
        _getFlashMode = deps.getFlashMode;
        _getCaptureStream = deps.getCaptureStream;
        _setCropContext = deps.setCropContext;
        _removeQueuedPhotoById = deps.removeQueuedPhotoById;
    }

    // -- Public state accessors --

    function photos() { return galleryPhotos; }
    function size() { return galleryPhotos.length; }
    function getEditIndex() { return galleryEditIndex; }
    function nextId() { return ++photoIdCounter; }

    function addPhoto(photo) {
        galleryPhotos.push(photo);
        updateGalleryBadge();
    }

    // -- Gallery UI --

    function updateGalleryBadge() {
        const badge = document.getElementById('gallery-badge');
        const count = galleryPhotos.length;
        badge.textContent = count;
        if (count > 0) {
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    function openGallery() {
        if (galleryPhotos.length === 0) {
            _showToast(_i18n.t('send.noPhotos'));
            return;
        }
        // Turn off torch if active to save battery while browsing gallery
        const flashMode = _getFlashMode();
        const captureStream = _getCaptureStream();
        if (flashMode === 'torch' && captureStream) {
            const track = captureStream.getVideoTracks()[0];
            if (track) {
                track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
            }
        }
        // Pause camera to save resources while browsing gallery
        const video = document.getElementById('capture-video');
        if (video.srcObject) {
            video.srcObject.getTracks().forEach(t => t.enabled = false);
        }
        document.body.style.overflow = 'hidden';
        document.getElementById('gallery-modal').classList.remove('hidden');
        renderGalleryGrid();
    }

    function closeGallery() {
        document.getElementById('gallery-modal').classList.add('hidden');
        document.getElementById('gallery-edit-view').classList.add('hidden');
        galleryEditIndex = -1;
        // Resume camera
        const video = document.getElementById('capture-video');
        if (video.srcObject) {
            video.srcObject.getTracks().forEach(t => t.enabled = true);
        }
        // Re-enable torch if it was on before opening gallery
        const flashMode = _getFlashMode();
        const captureStream = _getCaptureStream();
        if (flashMode === 'torch' && captureStream) {
            const track = captureStream.getVideoTracks()[0];
            if (track) {
                track.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
            }
        }
        document.body.style.overflow = '';
    }

    function renderGalleryGrid() {
        const grid = document.getElementById('gallery-grid');
        grid.innerHTML = '';

        galleryPhotos.forEach((photo, idx) => {
            const thumb = document.createElement('div');
            thumb.className = 'gallery-thumb';
            thumb.draggable = true;
            thumb.dataset.index = idx;

            const img = document.createElement('img');
            img.src = photo.thumbUrl;
            img.alt = `Photo ${idx + 1}`;

            const indexBadge = document.createElement('span');
            indexBadge.className = 'gallery-thumb-index';
            indexBadge.textContent = idx + 1;

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'gallery-thumb-delete';
            deleteBtn.textContent = '✕';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteGalleryPhoto(idx);
            });

            thumb.appendChild(img);
            thumb.appendChild(indexBadge);
            thumb.appendChild(deleteBtn);

            // Tap to open edit view
            thumb.addEventListener('click', () => openGalleryEdit(idx));

            // Drag-and-drop reorder
            thumb.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', idx);
                thumb.classList.add('dragging');
            });
            thumb.addEventListener('dragend', () => thumb.classList.remove('dragging'));
            thumb.addEventListener('dragover', (e) => {
                e.preventDefault();
                thumb.classList.add('drag-over');
            });
            thumb.addEventListener('dragleave', () => thumb.classList.remove('drag-over'));
            thumb.addEventListener('drop', (e) => {
                e.preventDefault();
                thumb.classList.remove('drag-over');
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                const toIdx = idx;
                if (fromIdx !== toIdx) {
                    const [moved] = galleryPhotos.splice(fromIdx, 1);
                    galleryPhotos.splice(toIdx, 0, moved);
                    renderGalleryGrid();
                }
            });

            // Touch-based reorder: long press to drag
            let touchTimer = null;
            let touchDragging = false;
            let touchFromIdx = -1;
            thumb.addEventListener('touchstart', (e) => {
                touchTimer = setTimeout(() => {
                    touchDragging = true;
                    touchFromIdx = idx;
                    thumb.classList.add('dragging');
                }, 400);
            }, { passive: true });
            thumb.addEventListener('touchmove', () => {
                if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
            });
            thumb.addEventListener('touchend', (e) => {
                if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
                if (touchDragging) {
                    // Find element under touch
                    const touch = e.changedTouches[0];
                    const target = document.elementFromPoint(touch.clientX, touch.clientY);
                    const targetThumb = target ? target.closest('.gallery-thumb') : null;
                    if (targetThumb && targetThumb.dataset.index !== undefined) {
                        const toIdx = parseInt(targetThumb.dataset.index);
                        if (touchFromIdx !== toIdx) {
                            const [moved] = galleryPhotos.splice(touchFromIdx, 1);
                            galleryPhotos.splice(toIdx, 0, moved);
                        }
                    }
                    touchDragging = false;
                    touchFromIdx = -1;
                    renderGalleryGrid();
                }
            });

            grid.appendChild(thumb);
        });

        // Update send button label
        const label = document.getElementById('gallery-send-label');
        label.textContent = _i18n.t('send.sendAll').replace('{n}', galleryPhotos.length);
    }

    function deleteGalleryPhoto(idx) {
        const photo = galleryPhotos[idx];
        if (photo.thumbUrl) URL.revokeObjectURL(photo.thumbUrl);

        // If already sent to receiver, tell receiver to delete it
        if (photo.sentHash) {
            _getRtc().sendMessage(Protocol.build.deleteImage(photo.sentHash));
        } else {
            _removeQueuedPhotoById(photo.id);
        }

        galleryPhotos.splice(idx, 1);
        updateGalleryBadge();
        if (galleryPhotos.length === 0) {
            closeGallery();
        } else {
            renderGalleryGrid();
        }
    }

    function clearGallery() {
        galleryPhotos.forEach(p => {
            if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
            // If already sent, tell receiver to delete
            if (p.sentHash) {
                _getRtc().sendMessage(Protocol.build.deleteImage(p.sentHash));
            } else {
                _removeQueuedPhotoById(p.id);
            }
        });
        galleryPhotos = [];
        updateGalleryBadge();
        closeGallery();
    }

    function openGalleryEdit(idx) {
        galleryEditIndex = idx;
        const photo = galleryPhotos[idx];
        const editView = document.getElementById('gallery-edit-view');
        const editImg = document.getElementById('gallery-edit-image');

        if (editImg.src && editImg.src.startsWith('blob:')) {
            URL.revokeObjectURL(editImg.src);
        }
        editImg.src = URL.createObjectURL(photo.blob);
        editView.classList.remove('hidden');

        // Reset B&W state
        document.getElementById('gallery-bw-btn').classList.remove('active');
    }

    function closeGalleryEdit() {
        document.getElementById('gallery-edit-view').classList.add('hidden');
        galleryEditIndex = -1;
        renderGalleryGrid();
    }

    async function applyGalleryTransform(transformFn) {
        if (galleryEditIndex < 0 || galleryEditIndex >= galleryPhotos.length) return;
        const photo = galleryPhotos[galleryEditIndex];

        // transformFn(blob) returns either a Blob or {data, mimeType}.
        const result = await transformFn(photo.blob);
        const resultBlob = result instanceof Blob
            ? result
            : new Blob([result.data], { type: result.mimeType });

        // Update gallery entry. originalBlob is the crop baseline and must
        // only be touched by applyCropResult — overwriting it here would
        // make a subsequent "crop from original" silently use the wrong
        // baseline after any prior rotate/flip/BW.
        if (photo.thumbUrl) URL.revokeObjectURL(photo.thumbUrl);
        photo.blob = resultBlob;
        photo.thumbUrl = URL.createObjectURL(resultBlob);

        // Refresh edit view
        const editImg = document.getElementById('gallery-edit-image');
        if (editImg.src && editImg.src.startsWith('blob:')) URL.revokeObjectURL(editImg.src);
        editImg.src = URL.createObjectURL(resultBlob);

        // If already sent, send transform commands instead of full resend
        if (photo.sentHash) {
            const oldHash = photo.sentHash;
            _logger.info(`Sending transform commands for ${oldHash.substring(0, 8)}... (${photo.transforms.length} ops)`);
            _getRtc().sendMessage(Protocol.build.transformImage(oldHash, photo.transforms));
            photo.sentHash = oldHash; // keep tracking (receiver will use same hash lookup)
        }
    }

    async function galleryRotateCW() {
        if (galleryEditIndex >= 0 && galleryEditIndex < galleryPhotos.length) {
            galleryPhotos[galleryEditIndex].transforms.push({ op: 'rotateCW' });
        }
        await applyGalleryTransform(blob => window.ImageTransforms.rotateImage(blob, { degrees: 90 }));
    }

    async function galleryFlipH() {
        if (galleryEditIndex >= 0 && galleryEditIndex < galleryPhotos.length) {
            galleryPhotos[galleryEditIndex].transforms.push({ op: 'flipH' });
        }
        await applyGalleryTransform(blob => window.ImageTransforms.flipImage(blob, { axis: 'h' }));
    }

    async function galleryApplyBW() {
        if (galleryEditIndex >= 0 && galleryEditIndex < galleryPhotos.length) {
            galleryPhotos[galleryEditIndex].transforms.push({ op: 'bw' });
        }
        await applyGalleryTransform(blob => window.ImageTransforms.binarize(blob));
        document.getElementById('gallery-bw-btn').classList.add('active');
    }

    function galleryOpenCrop() {
        if (galleryEditIndex < 0) return;
        const photo = galleryPhotos[galleryEditIndex];
        _setCropContext(photo.blob, photo.originalBlob);
        _openCropModal();
    }

    function applyCropResult(editIdx, { blob, corners }) {
        if (editIdx < 0 || editIdx >= galleryPhotos.length) return;
        const photo = galleryPhotos[editIdx];
        if (photo.thumbUrl) URL.revokeObjectURL(photo.thumbUrl);
        photo.blob = blob;
        photo.originalBlob = blob;
        photo.thumbUrl = URL.createObjectURL(blob);
        photo.transforms.push({ op: 'crop', corners });

        if (photo.sentHash) {
            const oldHash = photo.sentHash;
            _logger.info(`Sending transform commands for crop (replacing ${oldHash.substring(0, 8)}...)`);
            _getRtc().sendMessage(Protocol.build.transformImage(oldHash, photo.transforms));
        }

        openGalleryEdit(editIdx);
    }

    function finalizeBatch() {
        // Send batch-end to finalize the collection on the receiver
        _getRtc().sendMessage(Protocol.build.batchEnd());
        _logger.info('Batch finalized');

        // Clear gallery thumbnails (photos already sent)
        galleryPhotos.forEach(p => { if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl); });
        galleryPhotos = [];
        updateGalleryBadge();
        closeGallery();

        // Stop camera and return to choose step
        _stopCapture();
        _showStep(_stepChoose);
    }

    window.Gallery = {
        attach,
        photos,
        size,
        getEditIndex,
        nextId,
        addPhoto,
        updateGalleryBadge,
        openGallery,
        closeGallery,
        renderGalleryGrid,
        deleteGalleryPhoto,
        clearGallery,
        openGalleryEdit,
        closeGalleryEdit,
        galleryRotateCW,
        galleryFlipH,
        galleryApplyBW,
        galleryOpenCrop,
        applyCropResult,
        finalizeBatch,
    };
})();
