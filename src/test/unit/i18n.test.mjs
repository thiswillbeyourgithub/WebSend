/**
 * Unit tests for js/i18n.js, focused on the instance-branding logic added
 * alongside the BRANDING env var: {brand} substitution in t(), setBrand()
 * re-rendering + about-instance-line toggle, getBrand(), and the
 * filename-safe getBrandSlug().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

// --- Key coverage / locale parity ------------------------------------------
// t() returns the key itself when a key is missing (dict[key] ||
// translations.en[key] || key), so a never-defined key (e.g. a typo, or one
// only ever written as `i18n.t('x') || 'fallback'`) silently renders the raw
// key string to the user: the `|| 'fallback'` is dead because t() never
// returns a falsy value. These tests extract the en/fr dictionaries and every
// key referenced in the HTML/JS, then assert the two locales define the same
// keys and that every referenced key is defined in both.

// Parse one locale block out of the i18n.js source. The dictionaries are flat
// (no nested objects), so the block ends at the first line that is just a
// closing brace at the object's own indentation.
function extractLocaleKeys(source, locale) {
    const lines = source.split('\n');
    const start = lines.findIndex(l => new RegExp(`^\\s*${locale}:\\s*\\{`).test(l));
    assert.ok(start !== -1, `${locale} block not found in i18n.js`);
    const keys = new Set();
    const keyRe = /^\s*(['"])((?:[^'"\\]|\\.)*?)\1\s*:/;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^\s*\},?;?\s*$/.test(lines[i])) break; // end of this locale block
        const m = lines[i].match(keyRe);
        if (m) keys.add(m[2]);
    }
    return keys;
}

// Every i18n key referenced from markup (data-i18n / -placeholder / -title /
// -aria-label / -alt) or from JS (i18n.t / _i18n.t / i18nRef.t).
function collectReferencedKeys() {
    const publicDir = path.resolve(__dirname, '../../public');
    const refs = new Set();
    const tagRe = /data-i18n(?:-placeholder|-title|-aria-label|-alt)?\s*=\s*"([^"]+)"/g;
    const tRe = /i18n(?:Ref)?\.t\(\s*(['"])((?:[^'"\\]|\\.)*?)\1/g;
    const scan = (txt, { tags = false, file = '' } = {}) => {
        let m;
        if (tags) { while ((m = tagRe.exec(txt))) refs.add(m[1]); }
        while ((m = tRe.exec(txt))) {
            // i18n.js's own doc comment uses i18n.t('key') as an example.
            if (file === 'i18n.js' && m[2] === 'key') continue;
            refs.add(m[2]);
        }
    };
    for (const f of ['index.html', 'send.html', 'receive.html']) {
        scan(readFileSync(path.join(publicDir, f), 'utf8'), { tags: true });
    }
    const jsDir = path.join(publicDir, 'js');
    for (const f of readdirSync(jsDir)) {
        if (f.endsWith('.js')) scan(readFileSync(path.join(jsDir, f), 'utf8'), { file: f });
    }
    return refs;
}

test('exposes itself on window so window.i18n-guarded callers work', () => {
    // crop-modal.js and sidebar.js gate applyTranslations() / setBrand() behind
    // `window.i18n`. A top-level `const i18n` is NOT a window property, so
    // without an explicit window.i18n assignment those hooks silently no-op:
    // BRANDING never reaches the UI and the crop modal stays in English.
    // Loads via a real <script> (not eval) so const-vs-window scoping matches
    // the browser.
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'dangerously',
    });
    const script = dom.window.document.createElement('script');
    script.textContent = moduleSource;
    dom.window.document.body.appendChild(script);
    assert.equal(typeof dom.window.i18n, 'object', 'window.i18n must be defined');
    assert.equal(typeof dom.window.i18n.t, 'function');
    assert.equal(dom.window.i18n.t('app.name'), 'WebSend');
});

test('en and fr define exactly the same set of i18n keys', () => {
    const en = extractLocaleKeys(moduleSource, 'en');
    const fr = extractLocaleKeys(moduleSource, 'fr');
    assert.ok(en.size > 100, `sanity: expected many en keys, parsed ${en.size}`);
    const onlyEn = [...en].filter(k => !fr.has(k));
    const onlyFr = [...fr].filter(k => !en.has(k));
    assert.deepEqual(onlyEn, [], `keys defined in en but missing from fr: ${onlyEn.join(', ')}`);
    assert.deepEqual(onlyFr, [], `keys defined in fr but missing from en: ${onlyFr.join(', ')}`);
});

test('every i18n key referenced in HTML/JS is defined in both locales', () => {
    const en = extractLocaleKeys(moduleSource, 'en');
    const fr = extractLocaleKeys(moduleSource, 'fr');
    const missing = [...collectReferencedKeys()].filter(k => !en.has(k) || !fr.has(k)).sort();
    assert.deepEqual(missing, [],
        `referenced i18n keys not defined in both locales: ${missing.join(', ')}`);
});
