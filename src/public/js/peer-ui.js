/**
 * peer-ui.js
 *
 * Small UI helpers shared between sender and receiver pages:
 *   - loadEruda(): on-demand load of vendored mobile devtools console
 *   - onConnectionTypeDetected(info): show direct/relay badge in sidebar
 *   - showVerifiedInSidebar(): append "verified" line below the badge
 *
 * Exposed as window.PeerUI. Depends on global i18n (loaded earlier).
 */
(function () {
    'use strict';

    /**
     * Dynamically load the vendored eruda mobile devtools console.
     * Only called in DEV mode (or via the 5-tap gesture) to avoid loading
     * a ~500KB debug library on every page view. Served from /vendor/eruda/
     * so the app makes zero external network requests.
     * @returns {Promise<void>}
     */
    function loadEruda() {
        return new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = '/vendor/eruda/eruda.js';
            script.onload = () => { eruda.init(); resolve(); };
            script.onerror = () => { console.warn('Failed to load eruda'); resolve(); };
            document.head.appendChild(script);
        });
    }

    /**
     * Display a badge showing whether the connection is direct (P2P) or
     * relayed (TURN). Relay connections work fine (data is E2E encrypted)
     * but direct is faster.
     */
    function onConnectionTypeDetected(info) {
        const section = document.getElementById('sidebar-connection-section');
        const infoDiv = document.getElementById('sidebar-connection-info');
        if (!section || !infoDiv) return;
        section.classList.remove('hidden');

        if (info.type === 'relay') {
            infoDiv.style.background = '#fff3e0';
            infoDiv.style.border = '1px solid #ffcc80';
            infoDiv.innerHTML = `🔄 ${info.details}`;
            infoDiv.style.color = '#e65100';
        } else {
            infoDiv.style.background = '#e3f2fd';
            infoDiv.style.border = '1px solid #90caf9';
            infoDiv.innerHTML = `⚡ ${info.details}`;
            infoDiv.style.color = '#1565c0';
        }
    }

    /** Show "verified" status inside the sidebar CONNECTION section */
    function showVerifiedInSidebar() {
        const section = document.getElementById('sidebar-connection-section');
        const infoDiv = document.getElementById('sidebar-connection-info');
        if (!section || !infoDiv) return;
        section.classList.remove('hidden');
        const verifiedEl = document.createElement('div');
        verifiedEl.style.cssText = 'margin-top: 6px; color: #2e7d32; font-weight: bold;';
        verifiedEl.textContent = i18n.t('connection.verified');
        infoDiv.appendChild(verifiedEl);
    }

    window.PeerUI = { loadEruda, onConnectionTypeDetected, showVerifiedInSidebar };
})();
