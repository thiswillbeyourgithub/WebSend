/**
 * Unit test for the DEV maintenance banner age gate in sidebar.js.
 *
 * The banner warns that a DEV instance was recently restarted and may be
 * temporarily broken. On an instance that has been up for a long time that
 * warning is stale noise, so updateDevBadge() only makes the banner visible
 * when config.serverStartedAt is younger than 5 days. The DEV badge itself is
 * unaffected and must still show in either case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/sidebar.js');
const moduleSource = readFileSync(modulePath, 'utf8');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Load sidebar.js into a JSDOM window holding only the banner + badge nodes
 * updateDevBadge() touches, with a pass-through i18n stub.
 */
function loadSidebar() {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="maintenance-banner" class="maintenance-banner"></div>
        <span id="sidebar-dev-badge"></span>
        <span id="sidebar-version"></span>
    </body></html>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    const win = dom.window;
    win.i18n = { t: (key) => key };
    win.eval(moduleSource);
    return win;
}

function updateWith(win, startedAt) {
    win.updateDevBadge({ dev: true, version: '0.0.0', serverStartedAt: startedAt });
    return win.document.getElementById('maintenance-banner');
}

test('banner is shown for a restart younger than 5 days', () => {
    const win = loadSidebar();
    const banner = updateWith(win, Date.now() - 4 * DAY_MS);
    assert.ok(banner.classList.contains('visible'), 'recent restart should show the banner');
});

test('banner is hidden for a restart older than 5 days', () => {
    const win = loadSidebar();
    const banner = updateWith(win, Date.now() - 6 * DAY_MS);
    assert.ok(!banner.classList.contains('visible'), 'stale restart should not show the banner');
    assert.equal(banner.textContent, '', 'stale restart should not even fill the banner text');
});

test('DEV badge still activates when the banner is suppressed', () => {
    const win = loadSidebar();
    updateWith(win, Date.now() - 30 * DAY_MS);
    const badge = win.document.getElementById('sidebar-dev-badge');
    assert.ok(badge.classList.contains('dev-active'), 'the DEV badge is independent of the banner');
});

test('a missing serverStartedAt fails open and shows the banner', () => {
    const win = loadSidebar();
    win.updateDevBadge({ dev: true, version: '0.0.0' });
    const banner = win.document.getElementById('maintenance-banner');
    assert.ok(banner.classList.contains('visible'), 'unknown start time keeps the legacy behaviour');
});
