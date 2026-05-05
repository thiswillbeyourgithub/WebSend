/**
 * eruda-loader.js
 *
 * Shared on-demand loader for the vendored eruda mobile devtools console.
 * Exposes window.loadEruda() (used by sidebar.js's 5-tap gesture and by
 * the DEV-mode bootstrap in send.html / receive.html).
 *
 * Also auto-loads eruda when the URL contains ?debug=1, so debugging on a
 * mobile device only requires appending a query param.
 *
 * Eruda is served from /vendor/eruda/eruda.js — zero external network calls.
 */
(function () {
    'use strict';

    window.loadEruda = function () {
        return new Promise((resolve) => {
            if (typeof eruda !== 'undefined') { resolve(); return; }
            const script = document.createElement('script');
            script.src = '/vendor/eruda/eruda.js';
            script.onload = () => { eruda.init(); resolve(); };
            script.onerror = () => { console.warn('Failed to load eruda'); resolve(); };
            document.head.appendChild(script);
        });
    };

    try {
        if (new URLSearchParams(window.location.search).get('debug') === '1') {
            window.loadEruda();
        }
    } catch (_) { /* non-fatal */ }
})();
