/**
 * Unit test for logger.js panel DOM cap.
 *
 * A hostile peer flooding pre-verification garbage causes logger.warn /
 * logger.error to fire on every message. Without bounds, the logs panel
 * DOM grows unbounded until the tab OOMs. Defense-in-depth: cap the panel
 * children at maxLogs, and only mutate the DOM when the panel is open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/logger.js');
const moduleSource = readFileSync(modulePath, 'utf8');

function loadLogger() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'http://localhost/',
    });
    const win = dom.window;
    win.eval(moduleSource);
    // logger.js gates initLogsPanel() on document.readyState; JSDOM may
    // still be in 'loading'. Fire DOMContentLoaded so the panel + hooks
    // get installed before the test runs.
    if (win.document.readyState === 'loading') {
        win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true, cancelable: false }));
    }
    return win;
}

test('logger panel does NOT grow while hidden (closed-panel skip)', () => {
    const win = loadLogger();
    const panel = win.document.getElementById('logs-panel');
    assert.ok(panel, 'panel exists');
    assert.equal(panel.classList.contains('visible'), false);

    for (let i = 0; i < 1500; i++) win.logger.warn(`flood ${i}`);
    assert.equal(panel.children.length, 0,
        'closed panel must not gain DOM nodes from logger calls');
});

test('logger panel is capped at maxLogs while open', () => {
    const win = loadLogger();
    const panel = win.document.getElementById('logs-panel');
    win.openLogsPanel();
    assert.equal(panel.classList.contains('visible'), true);

    const cap = win.logger.maxLogs;
    for (let i = 0; i < cap + 500; i++) win.logger.warn(`flood ${i}`);

    assert.ok(panel.children.length <= cap,
        `panel children (${panel.children.length}) must not exceed maxLogs (${cap})`);
});

test('opening the panel after a hidden flood rebuilds from bounded in-memory log', () => {
    const win = loadLogger();
    const panel = win.document.getElementById('logs-panel');

    const cap = win.logger.maxLogs;
    for (let i = 0; i < cap + 500; i++) win.logger.warn(`flood ${i}`);
    assert.equal(panel.children.length, 0);
    assert.ok(win.logger.getLogs().length <= cap, 'in-memory log is already bounded');

    win.openLogsPanel();
    assert.ok(panel.children.length <= cap,
        'panel after open must reflect the bounded buffer, not the flood count');
});
