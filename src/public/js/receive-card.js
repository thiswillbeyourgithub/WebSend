/**
 * receive-card.js
 *
 * Builds the per-file card DOM rendered in the receive page's gallery
 * (image / pdf / other). Pure DOM construction: no parent lookup, no
 * appendChild, no drag-event setup — caller owns those side effects.
 *
 * Peer-controlled strings (filename, mimeType) reach this module via
 * encrypted metadata. All such strings are written through textContent
 * so a crafted filename like `<img src=x onerror=...>` cannot execute.
 *
 * Exposed as window.ReceiveCard.renderCard(opts) → HTMLElement.
 */
(function () {
    'use strict';

    function renderCard(opts) {
        const {
            url, filename, imageIndex, collectionId, fileType, fileSize, mimeType,
            i18n, getFileIcon, formatFileSize, handlers,
        } = opts;

        const item = document.createElement('div');
        item.className = 'received-image-item';
        item.setAttribute('data-image-index', imageIndex);
        item.setAttribute('data-collection-id', collectionId);
        item.setAttribute('draggable', 'true');

        // Handlers read the live index from the DOM so reorder works without
        // patching every event listener. Index-suffixed IDs are tracked in
        // `idElements` and rewritten by item.__updateIndex on reorder.
        const getIdx = () => parseInt(item.getAttribute('data-image-index'));
        const idElements = []; // [{el, prefix}]
        function trackId(el, prefix, idx) {
            el.id = `${prefix}${idx}`;
            idElements.push({ el, prefix });
        }

        const dragHandle = document.createElement('div');
        dragHandle.className = 'drag-handle';
        dragHandle.title = 'Drag to reorder';
        dragHandle.textContent = '☰';
        item.appendChild(dragHandle);

        // Discard-confirm panel (identical across fileTypes)
        const discardConfirm = document.createElement('div');
        discardConfirm.className = 'discard-confirm hidden';
        const discardMsg = document.createElement('p');
        discardMsg.className = 'discard-confirm-msg';
        discardMsg.textContent = i18n.t('receive.discardConfirm');
        discardConfirm.appendChild(discardMsg);
        const discardBtnRow = document.createElement('div');
        discardBtnRow.className = 'discard-confirm-row';
        const yesBtn = document.createElement('button');
        yesBtn.className = 'btn btn-action discard-confirm-yes';
        yesBtn.textContent = i18n.t('receive.discardYes');
        yesBtn.addEventListener('click', () => handlers.onDiscardConfirm(getIdx()));
        const noBtn = document.createElement('button');
        noBtn.className = 'btn btn-action btn-secondary';
        noBtn.textContent = i18n.t('receive.discardNo');
        noBtn.addEventListener('click', () => handlers.onDiscardCancel(getIdx()));
        discardBtnRow.append(yesBtn, noBtn);
        discardConfirm.appendChild(discardBtnRow);

        // Hidden selection checkbox (shared)
        const selectCheckbox = document.createElement('input');
        selectCheckbox.type = 'checkbox';
        selectCheckbox.checked = true;
        trackId(selectCheckbox, 'select-', imageIndex);
        selectCheckbox.className = 'card-select-checkbox';
        selectCheckbox.addEventListener('change', () => handlers.onSelectionChange());

        // Kebab button (shared)
        const kebabBtn = document.createElement('button');
        kebabBtn.className = 'card-kebab-btn';
        kebabBtn.title = 'Actions';
        kebabBtn.textContent = '⋮';
        kebabBtn.addEventListener('click', (e) => handlers.onToggleCardMenu(e, getIdx()));

        function buildCardMenu(entries) {
            const menu = document.createElement('div');
            menu.className = 'card-menu hidden';
            trackId(menu, 'card-menu-', imageIndex);
            for (const entry of entries) {
                const el = document.createElement(entry.tag || 'button');
                el.className = 'card-menu-item' + (entry.danger ? ' card-menu-item-danger' : '');
                if (entry.idPrefix) {
                    trackId(el, entry.idPrefix, imageIndex);
                } else if (entry.id) {
                    el.id = entry.id;
                }
                if (entry.href) el.href = entry.href;
                if (entry.download !== undefined) el.download = entry.download;
                if (entry.children) {
                    for (const c of entry.children) el.appendChild(c);
                } else {
                    el.textContent = entry.label;
                }
                el.addEventListener('click', () => {
                    if (entry.onClick) entry.onClick(el);
                    handlers.onCloseCardMenu(getIdx());
                });
                menu.appendChild(el);
            }
            return menu;
        }

        function makeBadge(variantClass) {
            const badge = document.createElement('span');
            badge.className = `image-badge ${variantClass}`;
            badge.textContent = `#${imageIndex + 1}`;
            return badge;
        }

        // The select menu-item carries two spans with stable IDs so other code
        // can flip them via getElementById when the selection toggles.
        function makeSelectMenuItem() {
            const iconSpan = document.createElement('span');
            trackId(iconSpan, 'select-icon-', imageIndex);
            iconSpan.textContent = '☑️';
            const labelSpan = document.createElement('span');
            trackId(labelSpan, 'select-label-', imageIndex);
            labelSpan.textContent = i18n.t('receive.toggleSelect');
            const space = document.createTextNode(' ');
            return {
                tag: 'button',
                children: [iconSpan, space, labelSpan],
                onClick: () => handlers.onToggleSelectFromMenu(getIdx()),
            };
        }

        if (fileType === 'image') {
            const thumb = document.createElement('div');
            thumb.className = 'image-thumb-container';

            const img = document.createElement('img');
            img.src = url;
            img.alt = 'Received photo';
            trackId(img, 'img-', imageIndex);
            img.addEventListener('click', (event) => {
                if (event.shiftKey) handlers.onToggleSelectFromMenu(getIdx());
                else handlers.onOpenLightbox(getIdx());
            });
            thumb.appendChild(img);
            thumb.appendChild(makeBadge('image-badge-overlay'));
            thumb.appendChild(selectCheckbox);
            thumb.appendChild(kebabBtn);

            const menu = buildCardMenu([
                makeSelectMenuItem(),
                { label: `🔄 ${i18n.t('send.rotate')}`, onClick: () => handlers.onRotate(getIdx()) },
                { label: `✂️ ${i18n.t('receive.crop')}`, onClick: () => handlers.onCrop(getIdx()) },
                { label: `⬛ ${i18n.t('send.applyBW')}`, onClick: () => handlers.onBW(getIdx()) },
                { tag: 'a', href: url, download: filename, idPrefix: 'download-', label: `📥 ${i18n.t('receive.download')}` },
                { label: `🗑️ ${i18n.t('receive.discard')}`, danger: true, onClick: () => handlers.onDiscard(getIdx()) },
            ]);
            thumb.appendChild(menu);

            item.appendChild(thumb);
            item.appendChild(discardConfirm);
        } else if (fileType === 'pdf' || fileType === 'other') {
            const card = document.createElement('div');
            card.className = 'file-card';

            const iconSpan = document.createElement('span');
            iconSpan.className = 'file-card-icon';
            iconSpan.textContent = fileType === 'pdf' ? '📄' : getFileIcon(mimeType);
            card.appendChild(iconSpan);

            card.appendChild(makeBadge('image-badge-stacked'));

            const nameP = document.createElement('p');
            nameP.className = 'file-card-name';
            nameP.textContent = filename;
            card.appendChild(nameP);

            const sizeP = document.createElement('p');
            sizeP.className = 'file-card-size';
            sizeP.textContent = formatFileSize(fileSize);
            card.appendChild(sizeP);

            card.appendChild(selectCheckbox);
            card.appendChild(kebabBtn);

            const entries = [
                makeSelectMenuItem(),
                { tag: 'a', href: url, download: filename, idPrefix: 'download-', label: `📥 ${i18n.t('receive.download')}` },
            ];
            if (fileType === 'pdf') {
                entries.push(
                    { label: `📸 ${i18n.t('receive.pdfToImages')}`, onClick: (btn) => handlers.onPdfToImages(getIdx(), btn) },
                    { label: `📝 ${i18n.t('receive.pdfToOcr')}`, onClick: (btn) => handlers.onPdfToOcr(getIdx(), btn) },
                );
            }
            entries.push({ label: `🗑️ ${i18n.t('receive.discard')}`, danger: true, onClick: () => handlers.onDiscard(getIdx()) });
            card.appendChild(buildCardMenu(entries));

            item.appendChild(card);
            item.appendChild(discardConfirm);
        }

        // Reorder hook: rewrite all index-suffixed IDs and the data attribute
        // in one O(idElements.length) pass — no DOM selector walks, no regex,
        // and no inline onclick patching. The download anchor's `download`
        // attribute is updated from the (caller-provided) name.
        item.__updateIndex = (newIdx, downloadName) => {
            item.setAttribute('data-image-index', newIdx);
            for (const { el, prefix } of idElements) el.id = `${prefix}${newIdx}`;
            const dl = idElements.find(e => e.prefix === 'download-');
            if (dl && downloadName) dl.el.download = downloadName;
        };

        return item;
    }

    /**
     * Replace a card's img src and download href with a fresh blob URL created
     * from `blob`. Revokes the previous URL. Returns the new URL string.
     */
    function setCardImage(imageIndex, blob, opts = {}) {
        const img = document.getElementById(`img-${imageIndex}`);
        const dl  = document.getElementById(`download-${imageIndex}`);
        const oldUrl = img ? img.src : (dl ? dl.href : '');
        const newUrl = URL.createObjectURL(blob);
        if (img) img.src = newUrl;
        if (dl)  dl.href = newUrl;
        if (dl && opts.filename) dl.download = opts.filename;
        if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
        return newUrl;
    }

    /**
     * Revoke the blob URL(s) held by a card. Accepts either an imageIndex
     * (number) or an existing card element.
     */
    function revokeCardUrls(target) {
        const card = (typeof target === 'number')
            ? document.querySelector(`.received-image-item[data-image-index="${target}"]`)
            : target;
        if (!card) return;
        const img = card.querySelector('img');
        if (img && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
        const dl = card.querySelector('a[id^="download-"]');
        if (dl && dl.href.startsWith('blob:') && (!img || dl.href !== img.src)) {
            URL.revokeObjectURL(dl.href);
        }
    }

    window.ReceiveCard = { renderCard, setCardImage, revokeCardUrls };
})();
