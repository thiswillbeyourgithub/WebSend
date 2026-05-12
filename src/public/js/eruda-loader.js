/**
 * eruda-loader.js
 *
 * Shared on-demand loader for the vendored eruda mobile devtools console.
 * Exposes window.loadEruda() (used by sidebar.js's 5-tap gesture and by
 * the DEV-mode bootstrap in send.html / receive.html).
 *
 * Auto-loads eruda when:
 *   - the URL contains ?debug=1, or
 *   - localStorage has the "eruda-persist" flag set (sticky across reloads
 *     once the 5-tap gesture or ?debug=1 has loaded eruda).
 *
 * To stop the sticky auto-load, append ?debug=0 to the URL once.
 *
 * Eruda is served from /vendor/eruda/eruda.js, zero external network calls.
 */
(function () {
    'use strict';

    const PERSIST_KEY = 'eruda-persist';

    function safeSet(v) { try { localStorage.setItem(PERSIST_KEY, v); } catch (_) {} }
    function safeRemove() { try { localStorage.removeItem(PERSIST_KEY); } catch (_) {} }
    function safeGet() { try { return localStorage.getItem(PERSIST_KEY); } catch (_) { return null; } }

    window.loadEruda = function () {
        return new Promise((resolve) => {
            if (typeof eruda !== 'undefined') { safeSet('1'); resolve(); return; }
            const script = document.createElement('script');
            script.src = '/vendor/eruda/eruda.js';
            script.onload = () => { eruda.init(); safeSet('1'); resolve(); };
            script.onerror = () => { console.warn('Failed to load eruda'); resolve(); };
            document.head.appendChild(script);
        });
    };

    try {
        const debugParam = new URLSearchParams(window.location.search).get('debug');
        if (debugParam === '0') {
            safeRemove();
        } else if (debugParam === '1' || safeGet() === '1') {
            window.loadEruda();
        }
    } catch (_) { /* non-fatal */ }
})();
