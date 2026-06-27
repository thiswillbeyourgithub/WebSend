/**
 * Shared sidebar module for WebSend (index, receive, send pages).
 *
 * The sidebar (kebab button, overlay, language selector, connection info, logs/about
 * actions, DEV badge) was previously copy-pasted identically into index.html,
 * receive.html, and send.html. This module centralises both the markup and the
 * event-handler wiring so a change only needs to happen once.
 *
 * Usage — call once after the page's own scripts have loaded (i18n must be ready):
 *
 *   buildSidebar({ showLogs: true });   // inserts DOM at the top of <body>
 *   initSidebar();                       // wires all event handlers
 *
 * Then, after fetching /api/config, call:
 *   updateDevBadge(config.dev);
 *
 * The `updateDevBadge` function is also attached to `window` so pages can call it
 * as a global without an explicit import.
 */

/**
 * Insert the sidebar markup at the top of <body>.
 * Uses innerHTML on a trusted static template (no user-controlled data involved),
 * so there is no XSS risk here. The alternative (50+ createElement calls) would
 * be far harder to read and maintain.
 *
 * @param {object} opts
 * @param {boolean} [opts.showLogs=true] - Whether to show the Logs action button.
 *   Pass false on the index page which has no log panel.
 */
function buildSidebar({ showLogs = true } = {}) {
    const logsHidden = showLogs ? '' : ' hidden';

    const html = `
    <!-- Banner text (including the "restarted X ago" age) is injected by
         updateDevBadge() with i18n interpolation; no data-i18n here so a later
         language switch cannot replace it with the raw "{age}" template. -->
    <div id="maintenance-banner" class="maintenance-banner"></div>
    <!-- Settings button: opens sidebar with settings, logs, about -->
    <button class="kebab-btn" id="kebab-btn" aria-label="Settings"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>

    <!-- Sidebar overlay (dark background) -->
    <div class="sidebar-overlay" id="sidebar-overlay"></div>

    <!-- Sidebar -->
    <div class="sidebar" id="sidebar">
        <button class="sidebar-close" id="sidebar-close">✕</button>

        <!-- Brand / icon -->
        <div class="sidebar-brand">
            <img src="/icons/icon.svg" alt="" class="sidebar-brand-icon" width="56" height="56">
            <div class="sidebar-brand-name" data-i18n="app.name">WebSend</div>
        </div>

        <!-- Language section -->
        <div class="sidebar-section">
            <div class="sidebar-section-title" data-i18n="menu.language">Language</div>
            <button class="lang-option" data-lang="en">🇬🇧 English</button>
            <button class="lang-option" data-lang="fr">🇫🇷 Français</button>
        </div>

        <!-- Connection info (only visible when connected) -->
        <div class="sidebar-section hidden" id="sidebar-connection-section">
            <div class="sidebar-section-title" data-i18n="menu.connection">Connection</div>
            <div class="sidebar-connection-info" id="sidebar-connection-info"></div>
        </div>

        <!-- Actions -->
        <div class="sidebar-section">
            <button class="sidebar-action${logsHidden}" id="sidebar-logs-btn">
                <span>📋</span>
                <span data-i18n="menu.logs">Logs</span>
            </button>
            <button class="sidebar-action" id="sidebar-about-btn">
                <span>ℹ️</span>
                <span data-i18n="menu.about">About</span>
            </button>
        </div>

        <!-- DEV mode indicator (updated after fetching /api/config) -->
        <div class="sidebar-section" id="sidebar-dev-section">
            <div class="sidebar-dev-badge" id="sidebar-dev-badge" data-i18n="menu.prodMode">Production mode</div>
            <div class="sidebar-version" id="sidebar-version"></div>
        </div>
    </div>`;

    // Prepend before the page's own content at the top of <body>
    document.body.insertAdjacentHTML('afterbegin', html);

    // Apply i18n translations to the freshly-inserted markup
    if (window.i18n) i18n.applyTranslations();
}

/**
 * Wire all sidebar event handlers. Must be called after buildSidebar() and after
 * i18n is ready (i18n.init() must have run).
 *
 * Handles: open/close toggle, language switching, logs panel, about modal/redirect.
 *
 * The 5-tap eruda loader on the DEV badge calls `window.loadEruda` — each page
 * defines that function itself (receive/send use the logger-aware version; index
 * defines a minimal local version). If `window.loadEruda` is not defined the
 * 5-tap gesture simply does nothing.
 */
function initSidebar() {
    const kebabBtn = document.getElementById('kebab-btn');
    const sidebar  = document.getElementById('sidebar');
    const overlay  = document.getElementById('sidebar-overlay');
    const closeBtn = document.getElementById('sidebar-close');

    function openSidebar()  { sidebar.classList.add('visible');    overlay.classList.add('visible'); }
    function closeSidebar() { sidebar.classList.remove('visible'); overlay.classList.remove('visible'); }

    kebabBtn.addEventListener('click', openSidebar);
    closeBtn.addEventListener('click', closeSidebar);
    overlay.addEventListener('click', closeSidebar);

    // Language switcher
    const langOptions = sidebar.querySelectorAll('.lang-option');
    function updateLangUI() {
        const locale = i18n.getLocale();
        langOptions.forEach(opt => opt.classList.toggle('active', opt.dataset.lang === locale));
    }
    langOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            i18n.setLocale(opt.dataset.lang);
            updateLangUI();
            // Keep the log-panel toolbar labels in sync after a language change
            const closeLogsBtn = document.getElementById('logs-close-btn');
            const copyLogsBtn  = document.getElementById('logs-copy-btn');
            if (closeLogsBtn) closeLogsBtn.textContent = i18n.t('menu.closeLogs');
            if (copyLogsBtn)  copyLogsBtn.textContent  = i18n.t('menu.copyLogs');
        });
    });
    updateLangUI();

    // Logs button (only present on send/receive pages)
    document.getElementById('sidebar-logs-btn').addEventListener('click', () => {
        closeSidebar();
        if (window.openLogsPanel) window.openLogsPanel();
    });

    // About button — open in-page modal if it exists, otherwise navigate to /#about
    document.getElementById('sidebar-about-btn').addEventListener('click', () => {
        closeSidebar();
        const aboutModal = document.getElementById('about-modal');
        if (aboutModal) {
            aboutModal.classList.remove('hidden');
            aboutModal.style.display = 'flex';
        } else {
            window.location.href = '/#about';
        }
    });

    // 5-tap on the DEV badge to load eruda in production — useful for on-device debugging
    // without needing to restart the server with DEV=1. Delegates to window.loadEruda
    // which each page defines independently (index.html uses a plain version; receive/send
    // use the logger-aware version).
    (function() {
        const badge = document.getElementById('sidebar-dev-badge');
        if (!badge) return;
        let tapCount = 0;
        let tapTimer = null;
        badge.addEventListener('click', () => {
            tapCount++;
            clearTimeout(tapTimer);
            tapTimer = setTimeout(() => { tapCount = 0; }, 1500);
            if (tapCount >= 5) {
                tapCount = 0;
                if (typeof eruda !== 'undefined') return; // already loaded
                if (window.loadEruda) window.loadEruda().then(() => {
                    if (window.logger) logger.info('Eruda loaded via 5-tap');
                    else console.info('Eruda loaded via 5-tap');
                });
            }
        });
    })();
}

/**
 * Turn a server start timestamp (epoch ms, from /api/config.serverStartedAt)
 * into a localized "restarted X ago" phrase for the DEV maintenance banner.
 * Picks the coarsest sensible unit (days > hours > minutes) so users can tell
 * at a glance how recently the instance was restarted, and thus how likely it
 * is to have just been modified and broken.
 *
 * @param {number|null} startedAt - Epoch ms the server process started.
 * @returns {string} A translated relative-time string (e.g. "2 hours ago").
 */
function formatStartAge(startedAt) {
    if (!startedAt || typeof startedAt !== 'number') return i18n.t('maintenance.ageJustNow');
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    const hours   = Math.floor(minutes / 60);
    const days    = Math.floor(hours / 24);
    if (days >= 1)    return i18n.t(days    === 1 ? 'maintenance.ageDay'    : 'maintenance.ageDays',    { n: days });
    if (hours >= 1)   return i18n.t(hours   === 1 ? 'maintenance.ageHour'   : 'maintenance.ageHours',   { n: hours });
    if (minutes >= 1) return i18n.t(minutes === 1 ? 'maintenance.ageMinute' : 'maintenance.ageMinutes', { n: minutes });
    return i18n.t('maintenance.ageJustNow');
}

/**
 * Update the DEV-mode badge and version line in the sidebar after fetching /api/config.
 * Also shows the maintenance banner when in DEV mode (the banner text is set by i18n).
 *
 * Accepts either the full config object ({dev, version, ...}) or just the legacy
 * boolean isDev. Passing the full config also fills in the sidebar version line.
 *
 * @param {object|boolean} config - The /api/config response, or just its `dev` flag.
 */
function updateDevBadge(config) {
    const isDev   = typeof config === 'object' && config !== null ? !!config.dev : !!config;
    const version = typeof config === 'object' && config !== null ? config.version : null;
    const startedAt = typeof config === 'object' && config !== null ? config.serverStartedAt : null;

    // Apply the instance brand (sidebar header, page heading, tab title, About
    // modal). Folded in here because this is the one config-driven hook every
    // page already calls after fetching /api/config.
    if (typeof config === 'object' && config !== null && config.branding
        && window.i18n && typeof i18n.setBrand === 'function') {
        i18n.setBrand(config.branding);
    }

    const badge = document.getElementById('sidebar-dev-badge');
    if (badge) {
        if (isDev) {
            badge.textContent = i18n.t('menu.devMode');
            badge.setAttribute('data-i18n', 'menu.devMode');
            badge.classList.add('dev-active');
            const banner = document.getElementById('maintenance-banner');
            if (banner) {
                banner.textContent = i18n.t('maintenance.banner', { age: formatStartAge(startedAt) });
                // The banner sentence ends right before the issues URL; append it
                // as a real clickable link. Built via DOM (not innerHTML) so the
                // translated text never passes through an HTML sink.
                const issuesLink = document.createElement('a');
                issuesLink.href = 'https://github.com/thiswillbeyourgithub/ImageSecureSend/issues';
                issuesLink.target = '_blank';
                issuesLink.rel = 'noopener';
                issuesLink.textContent = 'github.com/thiswillbeyourgithub/ImageSecureSend/issues';
                issuesLink.style.color = 'inherit';
                issuesLink.style.fontWeight = '700';
                issuesLink.style.textDecoration = 'underline';
                banner.appendChild(issuesLink);
                banner.classList.add('visible');
                banner.addEventListener('click', (e) => {
                    // Clicking the link should open the issue tracker, not dismiss
                    // the banner.
                    if (e.target.closest('a')) return;
                    banner.style.opacity = '0';
                    setTimeout(() => banner.classList.remove('visible'), 300);
                });
            }
        } else {
            badge.textContent = i18n.t('menu.prodMode');
            badge.setAttribute('data-i18n', 'menu.prodMode');
            badge.classList.remove('dev-active');
        }
    }

    const versionEl = document.getElementById('sidebar-version');
    if (versionEl && version) {
        versionEl.textContent = 'v' + version;
    }
}

// Expose as globals so pages can call them without module boilerplate
window.buildSidebar    = buildSidebar;
window.initSidebar     = initSidebar;
window.updateDevBadge  = updateDevBadge;
