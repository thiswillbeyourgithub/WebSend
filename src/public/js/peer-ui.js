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
     * Display a badge showing the active connection path:
     *   direct-p2p / direct-local  -> blue, lightning icon
     *   relay (TURN/TURNS)         -> amber, recycle icon (WebRTC over relay)
     *   relay-http / relay-https   -> amber, recycle icon (HTTP-relay fallback)
     * All paths are E2E encrypted, but direct is faster.
     */
    function onConnectionTypeDetected(info) {
        const section = document.getElementById('sidebar-connection-section');
        const infoDiv = document.getElementById('sidebar-connection-info');
        if (!section || !infoDiv) return;
        section.classList.remove('hidden');

        const isRelay = typeof info.type === 'string' && info.type.startsWith('relay');
        // textContent (not innerHTML) so future changes that route a server-
        // supplied or peer-supplied string into info.details cannot inject HTML.
        const prefix = isRelay ? '🔄 ' : '⚡ ';
        infoDiv.textContent = prefix + info.details;
        if (isRelay) {
            infoDiv.style.background = '#fff3e0';
            infoDiv.style.border = '1px solid #ffcc80';
            infoDiv.style.color = '#e65100';
        } else {
            infoDiv.style.background = '#e3f2fd';
            infoDiv.style.border = '1px solid #90caf9';
            infoDiv.style.color = '#1565c0';
        }

        // One-time hint when the HTTP-relay fallback wins. The badge alone
        // tells users the path is relayed; this hint explains that it is
        // expected to be slower than direct and is auto-selected because
        // the network blocked the faster paths.
        if ((info.type === 'relay-http' || info.type === 'relay-https') && !window._relayHintShown) {
            window._relayHintShown = true;
            const key = info.type === 'relay-https'
                ? 'connection.relayHttpSecureHint'
                : 'connection.relayHttpHint';
            const text = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t(key) : null;
            if (text && typeof window.showToast === 'function') {
                window.showToast(text, { type: 'warn', duration: 8000 });
            }
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
