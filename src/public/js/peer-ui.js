/**
 * peer-ui.js
 *
 * Small UI helpers shared between sender and receiver pages:
 *   - loadEruda(): re-export of window.loadEruda from eruda-loader.js
 *   - onConnectionTypeDetected(info): show direct/relay badge in sidebar
 *   - showVerifiedInSidebar(): append "verified" line below the badge
 *
 * Exposed as window.PeerUI. Depends on global i18n and eruda-loader (loaded earlier).
 */
(function () {
    'use strict';

    const loadEruda = window.loadEruda;

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

        // textContent (not innerHTML) so future changes that route a server-
        // supplied or peer-supplied string into info.details cannot inject HTML.
        const prefix = info.type === 'relay' ? '🔄 ' : '⚡ ';
        infoDiv.textContent = prefix + info.details;
        if (info.type === 'relay') {
            infoDiv.style.background = '#fff3e0';
            infoDiv.style.border = '1px solid #ffcc80';
            infoDiv.style.color = '#e65100';
        } else {
            infoDiv.style.background = '#e3f2fd';
            infoDiv.style.border = '1px solid #90caf9';
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

    /**
     * True when the supplied iceServers list includes any turn: or turns: URL.
     * Used by both sender and receiver to decide whether a connection
     * failure was likely caused by missing TURN relay.
     */
    function hasTurn(iceServers) {
        if (!Array.isArray(iceServers)) return false;
        return iceServers.some(s => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
            return urls.some(u => typeof u === 'string' && (u.startsWith('turn:') || u.startsWith('turns:')));
        });
    }

    window.PeerUI = { loadEruda, onConnectionTypeDetected, showVerifiedInSidebar, hasTurn };
})();
