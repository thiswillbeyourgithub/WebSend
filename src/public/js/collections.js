/**
 * collections.js
 *
 * Owns the receive page's "collections" (each batch from the sender =
 * one collection, displayed as a Document N section). Holds the
 * `collections` array, `activeCollectionId`, and all DOM rendering /
 * drag-and-drop wiring for collection sections.
 *
 * Cross-page references (the `receivedImages` array, page-level
 * callbacks like updateExportButton, and the per-card handlers map)
 * are wired in via Collections.attach({...}) once during page init.
 *
 * Exposed as window.Collections.
 */
(function () {
    'use strict';

    // -- State --
    let collections = []; // [{id, name, timeStr, images: [{data, mimeType, name, ...}], renamed?}]
    let nextCollectionId = 0;
    let activeCollectionId = null;

    // Drag/touch state
    let dragSrcEl = null;
    let touchDragEl = null;
    let touchClone = null;
    let longPressTimer = null;

    // -- Wired-in deps (set by attach) --
    let receivedImagesRef = null;
    let mainContainerEl = null;
    let i18nRef = null;
    let onUpdateExportButton = () => {};
    let onSelectionChange = () => {};
    let onOpenExportModal = () => {};
    let onCancelImageOcr = () => {};
    let cardHandlers = {};

    function attach(opts) {
        receivedImagesRef = opts.receivedImagesRef;
        mainContainerEl = opts.mainContainer;
        i18nRef = opts.i18n;
        if (opts.onUpdateExportButton) onUpdateExportButton = opts.onUpdateExportButton;
        if (opts.onSelectionChange) onSelectionChange = opts.onSelectionChange;
        if (opts.onOpenExportModal) onOpenExportModal = opts.onOpenExportModal;
        if (opts.onCancelImageOcr) onCancelImageOcr = opts.onCancelImageOcr;
        if (opts.cardHandlers) cardHandlers = opts.cardHandlers;
    }

    // -- Private helpers --
    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function getFileIcon(mimeType) {
        if (mimeType === 'application/pdf') return '📄';
        if (mimeType.startsWith('text/')) return '📝';
        if (mimeType.startsWith('audio/')) return '🎵';
        if (mimeType.startsWith('video/')) return '🎬';
        if (mimeType.includes('zip') || mimeType.includes('archive') || mimeType.includes('compressed')) return '📦';
        return '📎';
    }

    function updateBadgeNumbers() {
        const items = mainContainerEl.querySelectorAll('.received-image-item');
        const total = items.length;
        items.forEach((item, domIdx) => {
            const badge = item.querySelector('.image-badge');
            if (badge) badge.textContent = `#${total - domIdx}`;
        });
    }

    function updateImageCardIndex(card, newIndex) {
        const img = card.querySelector('img[id^="img-"]');
        if (img) {
            img.id = `img-${newIndex}`;
            img.setAttribute('onclick', `openLightbox(${newIndex})`);
        }
        const cb = card.querySelector('input[type="checkbox"][id^="select-"]');
        if (cb) cb.id = `select-${newIndex}`;
        const dl = card.querySelector('a[id^="download-"]');
        if (dl) dl.id = `download-${newIndex}`;
        const menu = card.querySelector('[id^="card-menu-"]');
        if (menu) menu.id = `card-menu-${newIndex}`;
        card.querySelectorAll('[onclick]').forEach(el => {
            el.setAttribute('onclick', el.getAttribute('onclick').replace(/\(\d+\)/g, `(${newIndex})`));
        });
        if (dl && receivedImagesRef[newIndex]) {
            dl.setAttribute('download', receivedImagesRef[newIndex].name);
        }
    }

    function reorderImages(srcEl, targetEl) {
        const container = srcEl.closest('.collection-images') || mainContainerEl;
        const items = [...container.querySelectorAll('.received-image-item')];
        const srcIdx = items.indexOf(srcEl);
        const targetIdx = items.indexOf(targetEl);

        const srcDataIdx = parseInt(srcEl.getAttribute('data-image-index'));
        const targetDataIdx = parseInt(targetEl.getAttribute('data-image-index'));

        const tmp = receivedImagesRef[srcDataIdx];
        receivedImagesRef[srcDataIdx] = receivedImagesRef[targetDataIdx];
        receivedImagesRef[targetDataIdx] = tmp;

        const colId = srcEl.getAttribute('data-collection-id');
        if (colId !== null) {
            const col = getById(parseInt(colId));
            if (col) {
                const srcImg = receivedImagesRef[srcDataIdx];
                const targetImg = receivedImagesRef[targetDataIdx];
                const si = col.images.indexOf(targetImg);
                const ti = col.images.indexOf(srcImg);
                if (si !== -1 && ti !== -1) {
                    const t = col.images[si];
                    col.images[si] = col.images[ti];
                    col.images[ti] = t;
                }
            }
        }

        srcEl.setAttribute('data-image-index', targetDataIdx);
        targetEl.setAttribute('data-image-index', srcDataIdx);

        updateImageCardIndex(srcEl, targetDataIdx);
        updateImageCardIndex(targetEl, srcDataIdx);

        if (srcIdx < targetIdx) {
            container.insertBefore(srcEl, targetEl.nextSibling);
        } else {
            container.insertBefore(srcEl, targetEl);
        }

        updateBadgeNumbers();
    }

    function showNewDocumentDropZone() {
        let zone = document.getElementById('new-document-drop-zone');
        if (!zone) {
            zone = document.createElement('div');
            zone.id = 'new-document-drop-zone';
            zone.className = 'new-document-drop-zone';
            zone.textContent = '＋ New Document';
            zone.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                zone.classList.add('new-document-drop-zone-active');
            });
            zone.addEventListener('dragleave', () => {
                zone.classList.remove('new-document-drop-zone-active');
            });
            zone.addEventListener('drop', (e) => {
                e.preventDefault();
                zone.classList.remove('new-document-drop-zone-active');
                const imageIndex = parseInt(e.dataTransfer.getData('text/plain'));
                if (!isNaN(imageIndex)) {
                    moveImageToNewCollection(imageIndex);
                }
            });
            mainContainerEl.appendChild(zone);
        }
        zone.style.display = 'flex';
    }

    function hideNewDocumentDropZone() {
        const zone = document.getElementById('new-document-drop-zone');
        if (zone) zone.style.display = 'none';
    }

    function moveImageToNewCollection(imageIndex) {
        const newColId = createNew();
        moveImage(imageIndex, newColId);
    }

    function handleDragStart(e) {
        dragSrcEl = this;
        this.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this.getAttribute('data-image-index'));
        showNewDocumentDropZone();
    }

    function handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }

    function handleDragEnter(e) {
        e.preventDefault();
        if (this !== dragSrcEl) this.classList.add('drag-over');
    }

    function handleDragLeave() {
        this.classList.remove('drag-over');
    }

    function handleDrop(e) {
        e.stopPropagation();
        e.preventDefault();
        if (dragSrcEl === this) return;
        this.classList.remove('drag-over');

        const srcColId = dragSrcEl.getAttribute('data-collection-id');
        const targetColId = this.getAttribute('data-collection-id');
        if (srcColId !== targetColId) {
            const imageIndex = parseInt(dragSrcEl.getAttribute('data-image-index'));
            moveImage(imageIndex, parseInt(targetColId));
        } else {
            reorderImages(dragSrcEl, this);
        }
    }

    function handleDragEnd() {
        this.classList.remove('dragging');
        document.querySelectorAll('.received-image-item').forEach(el => el.classList.remove('drag-over'));
        hideNewDocumentDropZone();
    }

    function handleTouchStart(e) {
        const item = e.target.closest('.received-image-item');
        longPressTimer = setTimeout(() => {
            e.preventDefault();
            touchDragEl = item;
            item.classList.add('dragging');
            showNewDocumentDropZone();

            touchClone = item.cloneNode(true);
            touchClone.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;opacity:0.7;width:' + item.offsetWidth + 'px;';
            const touch = e.touches[0];
            touchClone.style.left = touch.clientX - 30 + 'px';
            touchClone.style.top = touch.clientY - 30 + 'px';
            document.body.appendChild(touchClone);
        }, 400);
    }

    function handleTouchMove(e) {
        if (!touchDragEl) {
            clearTimeout(longPressTimer);
            return;
        }
        e.preventDefault();
        const touch = e.touches[0];
        if (touchClone) {
            touchClone.style.left = touch.clientX - 30 + 'px';
            touchClone.style.top = touch.clientY - 30 + 'px';
        }
        document.querySelectorAll('.received-image-item').forEach(el => el.classList.remove('drag-over'));
        document.querySelectorAll('.collection-header').forEach(el => el.classList.remove('collection-drop-target'));
        const newDocZone = document.getElementById('new-document-drop-zone');
        if (newDocZone) newDocZone.classList.remove('new-document-drop-zone-active');
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        if (target) {
            const targetItem = target.closest('.received-image-item');
            const targetHeader = target.closest('.collection-header');
            const targetNewDoc = target.closest('#new-document-drop-zone');
            if (targetNewDoc) {
                targetNewDoc.classList.add('new-document-drop-zone-active');
            } else if (targetHeader) {
                targetHeader.classList.add('collection-drop-target');
            } else if (targetItem && targetItem !== touchDragEl) {
                targetItem.classList.add('drag-over');
            }
        }
    }

    function handleTouchEnd(e) {
        clearTimeout(longPressTimer);
        if (!touchDragEl) return;

        const touch = e.changedTouches[0];
        if (touchClone) {
            touchClone.style.display = 'none';
        }
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        const targetItem = target ? target.closest('.received-image-item') : null;
        const targetNewDoc = target ? target.closest('#new-document-drop-zone') : null;
        const targetHeader = target ? target.closest('.collection-header') : null;

        if (targetNewDoc && touchDragEl) {
            const imageIndex = parseInt(touchDragEl.getAttribute('data-image-index'));
            moveImageToNewCollection(imageIndex);
        } else if (targetHeader && touchDragEl) {
            const targetColId = parseInt(targetHeader.getAttribute('data-collection-id'));
            const imageIndex = parseInt(touchDragEl.getAttribute('data-image-index'));
            moveImage(imageIndex, targetColId);
        } else if (targetItem && targetItem !== touchDragEl) {
            const srcColId = touchDragEl.getAttribute('data-collection-id');
            const tgtColId = targetItem.getAttribute('data-collection-id');
            if (srcColId !== tgtColId) {
                const imageIndex = parseInt(touchDragEl.getAttribute('data-image-index'));
                moveImage(imageIndex, parseInt(tgtColId));
            } else {
                reorderImages(touchDragEl, targetItem);
            }
        }

        touchDragEl.classList.remove('dragging');
        document.querySelectorAll('.received-image-item').forEach(el => el.classList.remove('drag-over'));
        document.querySelectorAll('.collection-header').forEach(el => el.classList.remove('collection-drop-target'));
        hideNewDocumentDropZone();
        if (touchClone) { touchClone.remove(); touchClone = null; }
        touchDragEl = null;
    }

    function setupDragEvents(item) {
        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('dragover', handleDragOver);
        item.addEventListener('dragenter', handleDragEnter);
        item.addEventListener('dragleave', handleDragLeave);
        item.addEventListener('drop', handleDrop);
        item.addEventListener('dragend', handleDragEnd);

        const handle = item.querySelector('.drag-handle');
        handle.addEventListener('touchstart', handleTouchStart, { passive: false });
        handle.addEventListener('touchmove', handleTouchMove, { passive: false });
        handle.addEventListener('touchend', handleTouchEnd);
    }

    function renderCollectionHeader(collectionId, name, timeStr) {
        if (collections.length === 1) {
            mainContainerEl.innerHTML = '';
        }

        const section = document.createElement('div');
        section.className = 'collection-section';
        section.setAttribute('data-collection-id', collectionId);
        const headerDiv = document.createElement('div');
        headerDiv.className = 'collection-header';
        headerDiv.setAttribute('data-collection-id', collectionId);

        const headerLeft = document.createElement('div');
        headerLeft.className = 'collection-header-left';

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'collection-collapse-btn';
        collapseBtn.title = 'Collapse/Expand';
        collapseBtn.textContent = '▼';
        collapseBtn.addEventListener('click', () => toggleCollapse(collectionId));

        const nameSpan = document.createElement('span');
        nameSpan.className = 'collection-name';
        nameSpan.contentEditable = 'true';
        nameSpan.spellcheck = false;
        nameSpan.textContent = name;
        nameSpan.addEventListener('blur', () => rename(collectionId, nameSpan.textContent));
        nameSpan.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); nameSpan.blur(); }
        });

        const timeSpan = document.createElement('span');
        timeSpan.className = 'collection-time';
        timeSpan.textContent = `(${timeStr})`;

        const countSpan = document.createElement('span');
        countSpan.className = 'collection-count';
        countSpan.id = `col-count-${collectionId}`;
        countSpan.textContent = '0';

        headerLeft.append(collapseBtn, nameSpan, timeSpan, countSpan);

        const headerRight = document.createElement('div');
        headerRight.className = 'collection-header-right';

        const selectAllLabel = (i18nRef && i18nRef.t('receive.selectAll')) || 'Select all';
        const selectAllBtn = document.createElement('button');
        selectAllBtn.className = 'btn btn-action collection-select-all-btn';
        selectAllBtn.title = selectAllLabel;
        selectAllBtn.textContent = selectAllLabel;
        selectAllBtn.addEventListener('click', () => toggleSelectAll(collectionId));

        const exportBtn = document.createElement('button');
        exportBtn.className = 'btn btn-action collection-export-btn';
        exportBtn.title = 'Export';
        exportBtn.textContent = '📦 Export';
        exportBtn.addEventListener('click', () => onOpenExportModal(collectionId));

        headerRight.append(selectAllBtn, exportBtn);
        headerDiv.append(headerLeft, headerRight);

        const imagesGrid = document.createElement('div');
        imagesGrid.className = 'collection-images';
        imagesGrid.id = `collection-images-${collectionId}`;
        imagesGrid.style.display = 'grid';
        imagesGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
        imagesGrid.style.gap = '15px';

        section.append(headerDiv, imagesGrid);
        mainContainerEl.prepend(section);

        // Make collection header a drop target for inter-collection drag
        const header = section.querySelector('.collection-header');
        header.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            header.classList.add('collection-drop-target');
        });
        header.addEventListener('dragleave', () => {
            header.classList.remove('collection-drop-target');
        });
        header.addEventListener('drop', (e) => {
            e.preventDefault();
            header.classList.remove('collection-drop-target');
            const imageIndex = parseInt(e.dataTransfer.getData('text/plain'));
            if (!isNaN(imageIndex)) {
                moveImage(imageIndex, collectionId);
            }
        });
    }

    // -- Public API --

    function reset() {
        collections = [];
        nextCollectionId = 0;
        activeCollectionId = null;
    }

    function list() { return collections; }
    function activeId() { return activeCollectionId; }

    function createNew() {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const id = nextCollectionId++;
        const name = `Document ${id + 1}`;
        collections.push({ id, name, timeStr, images: [] });
        activeCollectionId = id;
        renderCollectionHeader(id, name, timeStr);
        return id;
    }

    function getActive() {
        if (activeCollectionId === null || !collections.find(c => c.id === activeCollectionId)) {
            createNew();
        }
        return collections.find(c => c.id === activeCollectionId);
    }

    function peekActive() {
        if (activeCollectionId === null) return null;
        return collections.find(c => c.id === activeCollectionId) || null;
    }

    function getById(id) {
        return collections.find(c => c.id === id);
    }

    function getAllImages() {
        const result = [];
        for (const col of collections) {
            for (const img of col.images) {
                if (img !== null) result.push(img);
            }
        }
        return result;
    }

    function getTotalImageCount() {
        let count = 0;
        for (const col of collections) {
            for (const img of col.images) {
                if (img !== null) count++;
            }
        }
        return count;
    }

    function updateCount(collectionId) {
        const col = getById(collectionId);
        if (!col) return;
        const count = col.images.filter(img => img !== null).length;
        const el = document.getElementById(`col-count-${collectionId}`);
        if (el) el.textContent = count;
    }

    function rename(collectionId, newName) {
        const col = getById(collectionId);
        if (!col) return;
        const trimmed = newName.trim();
        if (!trimmed) return;
        col.name = trimmed;
        col.renamed = true;
        const safeName = trimmed.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').toLowerCase() || 'document';
        col.images.forEach((img, idx) => {
            const globalIdx = receivedImagesRef.indexOf(img);
            if (globalIdx < 0) return;
            const dlLink = document.getElementById(`download-${globalIdx}`);
            if (!dlLink) return;
            const ext = img.name ? img.name.split('.').pop() : (img.mimeType.split('/').pop().split('+')[0] || 'bin');
            const suffix = col.images.length > 1 ? `_${idx + 1}` : '';
            dlLink.setAttribute('download', `${safeName}${suffix}.${ext}`);
        });
    }

    function toggleCollapse(collectionId) {
        const section = document.querySelector(`.collection-section[data-collection-id="${collectionId}"]`);
        if (!section) return;
        const grid = section.querySelector('.collection-images');
        const btn = section.querySelector('.collection-collapse-btn');
        const collapsed = grid.style.display === 'none';
        grid.style.display = collapsed ? 'grid' : 'none';
        btn.textContent = collapsed ? '▼' : '▶';
    }

    function toggleSelectAll(collectionId) {
        const grid = document.getElementById(`collection-images-${collectionId}`);
        if (!grid) return;
        const checkboxes = grid.querySelectorAll('input[type="checkbox"][id^="select-"]');
        const allChecked = [...checkboxes].every(cb => cb.checked);
        checkboxes.forEach(cb => { cb.checked = !allChecked; });
        onSelectionChange();
    }

    function moveImage(imageIndex, targetCollectionId) {
        const img = receivedImagesRef[imageIndex];
        if (!img) return;

        let srcCol = null;
        for (const col of collections) {
            const idx = col.images.indexOf(img);
            if (idx !== -1) {
                col.images.splice(idx, 1);
                srcCol = col;
                break;
            }
        }

        const targetCol = getById(targetCollectionId);
        if (!targetCol) return;
        targetCol.images.push(img);

        const card = document.querySelector(`.received-image-item[data-image-index="${imageIndex}"]`);
        const targetGrid = document.getElementById(`collection-images-${targetCollectionId}`);
        if (card && targetGrid) {
            card.setAttribute('data-collection-id', targetCollectionId);
            targetGrid.appendChild(card);
        }

        if (srcCol) updateCount(srcCol.id);
        updateCount(targetCollectionId);
        updateBadgeNumbers();
    }

    function addReceivedFile(url, filename, imageIndex, collectionId, fileType, fileSize) {
        const container = document.getElementById(`collection-images-${collectionId}`);
        if (!container) return;

        const item = window.ReceiveCard.renderCard({
            url, filename, imageIndex, collectionId, fileType, fileSize,
            mimeType: receivedImagesRef[imageIndex] && receivedImagesRef[imageIndex].mimeType,
            i18n: i18nRef, getFileIcon, formatFileSize,
            handlers: cardHandlers,
        });

        container.appendChild(item);
        setupDragEvents(item);
        updateCount(collectionId);
    }

    function deleteByHash(hash) {
        const idx = receivedImagesRef.findIndex(img => img && img.hash === hash);
        if (idx === -1) {
            window.logger.warn('delete-image: no image found with hash ' + hash);
            return;
        }

        onCancelImageOcr(idx);

        window.ReceiveCard.revokeCardUrls(idx);

        const imgObj = receivedImagesRef[idx];
        if (imgObj) {
            for (const col of collections) {
                const colIdx = col.images.indexOf(imgObj);
                if (colIdx !== -1) {
                    col.images[colIdx] = null;
                    updateCount(col.id);
                    break;
                }
            }
        }

        receivedImagesRef[idx] = null;
        if (card) card.remove();
        onUpdateExportButton();
        window.logger.success('Deleted image with hash ' + hash.substring(0, 8) + '...');
    }

    /** Null out an image inside its owning collection (used by doDiscard). */
    function removeImageFromOwningCollection(imgObj) {
        if (!imgObj) return;
        for (const col of collections) {
            const idx = col.images.indexOf(imgObj);
            if (idx !== -1) {
                col.images[idx] = null;
                updateCount(col.id);
                return;
            }
        }
    }

    /** Set the (display) name of a collection without triggering rename's
     *  download-link rewrite (used when first non-image file arrives). */
    function setName(collectionId, newName) {
        const col = getById(collectionId);
        if (!col) return;
        col.name = newName;
        const section = document.querySelector(`.collection-section[data-collection-id="${collectionId}"]`);
        if (section) {
            const nameEl = section.querySelector('.collection-name');
            if (nameEl) nameEl.textContent = newName;
        }
    }

    window.Collections = {
        attach,
        reset,
        list,
        activeId,
        createNew,
        getActive,
        peekActive,
        getById,
        getAllImages,
        getTotalImageCount,
        updateCount,
        rename,
        setName,
        toggleCollapse,
        toggleSelectAll,
        moveImage,
        addReceivedFile,
        deleteByHash,
        removeImageFromOwningCollection,
    };
})();
