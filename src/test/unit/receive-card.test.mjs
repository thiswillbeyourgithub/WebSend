/**
 * Regression test for the XSS hardening in the receiver's card-render path.
 * Item 1 of PLAN.md (commit a1befcb) replaced innerHTML templating with
 * createElement + textContent — this test locks that property in so a
 * future "small" edit can't quietly reintroduce script-execution from a
 * peer-controlled filename.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/receive-card.js');
const moduleSource = readFileSync(modulePath, 'utf8');

function loadIntoJsdom() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
    dom.window.eval(moduleSource);
    return dom.window;
}

function makeOpts(overrides = {}) {
    return {
        url: 'blob:test/abc',
        filename: 'safe.jpg',
        imageIndex: 0,
        collectionId: 'col-1',
        fileType: 'image',
        fileSize: 1234,
        mimeType: 'image/jpeg',
        i18n: { t: (k) => k },
        getFileIcon: () => '?',
        formatFileSize: () => '1 KB',
        // Any handler call is a no-op — we never trigger UI events from a render-only test.
        handlers: new Proxy({}, { get: () => () => {} }),
        ...overrides,
    };
}

const CRAFTED = '<img src=x onerror="alert(1)"><script>alert(2)</script>.jpg';

for (const fileType of ['image', 'pdf', 'other']) {
    test(`renderCard(${fileType}): crafted filename does not produce executable HTML`, () => {
        const win = loadIntoJsdom();
        const item = win.ReceiveCard.renderCard(makeOpts({ filename: CRAFTED, fileType }));

        // No <script> elements anywhere in the subtree
        assert.equal(item.querySelectorAll('script').length, 0, 'no <script> elements');

        // Image branch yields exactly one <img> (the thumbnail). pdf/other yield zero.
        const imgs = item.querySelectorAll('img');
        const expectedImgs = fileType === 'image' ? 1 : 0;
        assert.equal(imgs.length, expectedImgs, `expected ${expectedImgs} <img> element(s)`);

        // No element anywhere has an inline event-handler attribute (onerror, onclick, ...).
        for (const el of item.querySelectorAll('*')) {
            for (const attr of el.attributes) {
                assert.ok(
                    !/^on/i.test(attr.name),
                    `unexpected event attribute ${attr.name}="${attr.value}" on <${el.tagName.toLowerCase()}>`,
                );
            }
        }

        // The literal filename string must surface verbatim somewhere — either as
        // text (pdf/other branches use .file-card-name) or as the download attr
        // (image branch only carries the filename via <a download="...">).
        const a = item.querySelector('a[download]');
        const surfacedAsText = item.textContent.includes(CRAFTED);
        const surfacedAsDownload = a && a.getAttribute('download') === CRAFTED;
        assert.ok(surfacedAsText || surfacedAsDownload, 'filename must appear verbatim somewhere in the rendered card');
    });
}

test('renderCard(image): img.src and download link reflect the url/filename verbatim', () => {
    const win = loadIntoJsdom();
    const item = win.ReceiveCard.renderCard(makeOpts({
        url: 'blob:foo/123',
        filename: 'pic.png',
        fileType: 'image',
    }));

    const img = item.querySelector('img');
    assert.equal(img.getAttribute('src'), 'blob:foo/123');

    const a = item.querySelector('a[download]');
    assert.equal(a.getAttribute('href'), 'blob:foo/123');
    assert.equal(a.getAttribute('download'), 'pic.png');
});

test('renderCard(pdf): filename appears in .file-card-name as plain text, not parsed HTML', () => {
    const win = loadIntoJsdom();
    const filename = '<b>not bold</b>.pdf';
    const item = win.ReceiveCard.renderCard(makeOpts({ filename, fileType: 'pdf' }));

    const nameEl = item.querySelector('.file-card-name');
    assert.equal(nameEl.textContent, filename);
    assert.equal(nameEl.querySelectorAll('b').length, 0, 'filename must not parse as HTML');
});
