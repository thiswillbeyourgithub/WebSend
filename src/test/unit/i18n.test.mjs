/**
 * Unit tests for js/i18n.js, focused on the instance-branding logic added
 * alongside the BRANDING env var: {brand} substitution in t(), setBrand()
 * re-rendering + about-instance-line toggle, getBrand(), and the
 * filename-safe getBrandSlug().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/i18n.js');
const moduleSource = readFileSync(modulePath, 'utf8');

function loadI18n(bodyHtml = '') {
    const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
        runScripts: 'outside-only',
        url: 'http://localhost/',
    });
    const win = dom.window;
    // i18n.js declares a top-level `const i18n`; surface it for the test.
    win.eval(moduleSource + '\nwindow.__i18n = i18n;');
    return win;
}

test('defaults to the WebSend brand before any config is applied', () => {
    const win = loadI18n();
    const i18n = win.__i18n;
    assert.equal(i18n.getBrand(), 'WebSend');
    assert.equal(i18n.getBrandSlug(), 'websend');
    assert.equal(i18n.t('app.name'), 'WebSend');
    assert.equal(i18n.t('about.title'), 'About WebSend');
});

test('setBrand updates the brand used by t(), getBrand and getBrandSlug', () => {
    const win = loadI18n();
    const i18n = win.__i18n;
    i18n.setBrand('Acme Corp');
    assert.equal(i18n.getBrand(), 'Acme Corp');
    // Slug is lowercased with spaces collapsed to underscores.
    assert.equal(i18n.getBrandSlug(), 'acme_corp');
    assert.equal(i18n.t('app.name'), 'Acme Corp');
    assert.equal(i18n.t('about.title'), 'About Acme Corp');
    assert.equal(i18n.t('about.instanceLine'),
        'Acme Corp is an instance running a program called WebSend.');
    assert.equal(i18n.t('receive.tabTitle'), 'Acme Corp - Receive Photos');
});

test('setBrand ignores empty / non-string values, keeping the previous brand', () => {
    const win = loadI18n();
    const i18n = win.__i18n;
    i18n.setBrand('Acme');
    i18n.setBrand('');
    i18n.setBrand('   ');
    i18n.setBrand(null);
    i18n.setBrand(42);
    assert.equal(i18n.getBrand(), 'Acme');
});

test('setBrand re-renders data-i18n elements with the new brand', () => {
    const win = loadI18n('<h1 data-i18n="app.name">WebSend</h1>');
    const i18n = win.__i18n;
    i18n.setBrand('Acme');
    assert.equal(win.document.querySelector('h1').textContent, 'Acme');
});

test('about-instance-line is shown only when the brand differs from WebSend', () => {
    const win = loadI18n('<p id="about-instance-line" class="hidden"></p>');
    const i18n = win.__i18n;
    const line = win.document.getElementById('about-instance-line');

    i18n.setBrand('Acme');
    assert.equal(line.classList.contains('hidden'), false, 'revealed for a renamed instance');

    i18n.setBrand('WebSend');
    assert.equal(line.classList.contains('hidden'), true, 'hidden on the default-branded build');
});
