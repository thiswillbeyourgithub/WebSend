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
        yesBtn.addEventListener('click', () => handlers.onDiscardConfirm(imageIndex));
        const noBtn = document.createElement('button');
        noBtn.className = 'btn btn-action btn-secondary';
        noBtn.textContent = i18n.t('receive.discardNo');
        noBtn.addEventListener('click', () => handlers.onDiscardCancel(imageIndex));
        discardBtnRow.append(yesBtn, noBtn);
        discardConfirm.appendChild(discardBtnRow);

        // Hidden selection checkbox (shared)
        const selectCheckbox = document.createElement('input');
        selectCheckbox.type = 'checkbox';
        selectCheckbox.checked = true;
        selectCheckbox.id = `select-${imageIndex}`;
        selectCheckbox.className = 'card-select-checkbox';
        selectCheckbox.addEventListener('change', () => handlers.onSelectionChange());

        // Kebab button (shared)
        const kebabBtn = document.createElement('button');
        kebabBtn.className = 'card-kebab-btn';
        kebabBtn.title = 'Actions';
        kebabBtn.textContent = '⋮';
        kebabBtn.addEventListener('click', (e) => handlers.onToggleCardMenu(e, imageIndex));

        function buildCardMenu(entries) {
            const menu = document.createElement('div');
            menu.className = 'card-menu hidden';
            menu.id = `card-menu-${imageIndex}`;
            for (const entry of entries) {
                const el = document.createElement(entry.tag || 'button');
                el.className = 'card-menu-item' + (entry.danger ? ' card-menu-item-danger' : '');
                if (entry.id) el.id = entry.id;
                if (entry.href) el.href = entry.href;
                if (entry.download !== undefined) el.download = entry.download;
                if (entry.children) {
                    for (const c of entry.children) el.appendChild(c);
                } else {
                    el.textContent = entry.label;
                }
                el.addEventListener('click', () => {
                    if (entry.onClick) entry.onClick();
                    handlers.onCloseCardMenu(imageIndex);
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
            iconSpan.id = `select-icon-${imageIndex}`;
            iconSpan.textContent = '☑️';
            const labelSpan = document.createElement('span');
            labelSpan.id = `select-label-${imageIndex}`;
            labelSpan.textContent = i18n.t('receive.toggleSelect');
            const space = document.createTextNode(' ');
            return {
                tag: 'button',
                children: [iconSpan, space, labelSpan],
                onClick: () => handlers.onToggleSelectFromMenu(imageIndex),
            };
        }

        if (fileType === 'image') {
            const thumb = document.createElement('div');
            thumb.className = 'image-thumb-container';

            const img = document.createElement('img');
            img.src = url;
            img.alt = 'Received photo';
            img.id = `img-${imageIndex}`;
            img.addEventListener('click', (event) => {
                if (event.shiftKey) handlers.onToggleSelectFromMenu(imageIndex);
                else handlers.onOpenLightbox(imageIndex);
            });
            thumb.appendChild(img);
            thumb.appendChild(makeBadge('image-badge-overlay'));
            thumb.appendChild(selectCheckbox);
            thumb.appendChild(kebabBtn);

            const menu = buildCardMenu([
                makeSelectMenuItem(),
                { label: `🔄 ${i18n.t('send.rotate')}`, onClick: () => handlers.onRotate(imageIndex) },
                { label: `✂️ ${i18n.t('receive.crop')}`, onClick: () => handlers.onCrop(imageIndex) },
                { label: `⬛ ${i18n.t('send.applyBW')}`, onClick: () => handlers.onBW(imageIndex) },
                { tag: 'a', href: url, download: filename, id: `download-${imageIndex}`, label: `📥 ${i18n.t('receive.download')}` },
                { label: `🗑️ ${i18n.t('receive.discard')}`, danger: true, onClick: () => handlers.onDiscard(imageIndex) },
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
                { tag: 'a', href: url, download: filename, id: `download-${imageIndex}`, label: `📥 ${i18n.t('receive.download')}` },
            ];
            if (fileType === 'pdf') {
                entries.push(
                    { label: `📸 ${i18n.t('receive.pdfToImages')}`, onClick: () => handlers.onPdfToImages(imageIndex) },
                    { label: `📝 ${i18n.t('receive.pdfToOcr')}`, onClick: () => handlers.onPdfToOcr(imageIndex) },
                );
            }
            entries.push({ label: `🗑️ ${i18n.t('receive.discard')}`, danger: true, onClick: () => handlers.onDiscard(imageIndex) });
            card.appendChild(buildCardMenu(entries));

            item.appendChild(card);
            item.appendChild(discardConfirm);
        }

        return item;
    }

    window.ReceiveCard = { renderCard };
})();
