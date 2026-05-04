/**
 * verification-modal.js
 *
 * Shared blocking modal for ECDH key fingerprint verification.
 * Used by both send.html and receive.html — extracted because the modal
 * structure, button wiring, and keyboard-listener cleanup were duplicated
 * verbatim, and the subtle keydown removal was easy to break independently.
 *
 * Exposed as window.VerificationModal.
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    let _onKeydown = null;

    function show({ onConfirm, onDeny }) {
        const modal = document.getElementById('verification-modal');
        modal.classList.remove('hidden');
        modal.style.display = 'flex';

        document.getElementById('confirm-match-btn').onclick = onConfirm;
        document.getElementById('deny-match-btn').onclick = onDeny;

        // Enter/Space = confirm, Escape = deny.
        _onKeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onConfirm();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                onDeny();
            }
        };
        document.addEventListener('keydown', _onKeydown);
    }

    function hide() {
        const modal = document.getElementById('verification-modal');
        if (_onKeydown) {
            document.removeEventListener('keydown', _onKeydown);
            _onKeydown = null;
        }
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }

    window.VerificationModal = { show, hide };
})();
