/**
 * Unit test for collections.js MAX_COLLECTIONS_PER_SESSION cap.
 *
 * A verified hostile peer that floods 'batch-start' messages must not be
 * able to grow the receiver's collections array (and the corresponding DOM)
 * without bound. createNew() refuses past the cap and returns the current
 * activeCollectionId.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/collections.js');
const moduleSource = readFileSync(modulePath, 'utf8');

function loadCollections() {
    const dom = new JSDOM('<!doctype html><html><body><div id="main"></div></body></html>', {
        runScripts: 'outside-only',
        url: 'http://localhost/',
    });
    const win = dom.window;
    win.logger = { info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {} };
    win.ReceiveCard = { revokeCardUrls: () => {} };
    win.eval(moduleSource);
    win.Collections.attach({
        receivedImagesRef: [],
        mainContainer: win.document.getElementById('main'),
        i18n: { t: (k) => k },
    });
    return win;
}

test('Collections exposes MAX_COLLECTIONS_PER_SESSION', () => {
    const win = loadCollections();
    assert.equal(typeof win.Collections.MAX_COLLECTIONS_PER_SESSION, 'number');
    assert.ok(win.Collections.MAX_COLLECTIONS_PER_SESSION > 0);
    assert.ok(win.Collections.MAX_COLLECTIONS_PER_SESSION <= 256, 'cap should be paranoid');
});

test('createNew() refuses past MAX_COLLECTIONS_PER_SESSION', () => {
    const win = loadCollections();
    const cap = win.Collections.MAX_COLLECTIONS_PER_SESSION;

    for (let i = 0; i < cap; i++) win.Collections.createNew();
    assert.equal(win.Collections.list().length, cap);

    // Flood past the cap, simulating a hostile verified peer spamming
    // batch-start. Length must not grow.
    const lastIdBefore = win.Collections.activeId();
    for (let i = 0; i < 200; i++) win.Collections.createNew();
    assert.equal(win.Collections.list().length, cap);
    assert.equal(win.Collections.activeId(), lastIdBefore,
        'activeId should not advance once the cap is hit');
});

test('reset() releases the cap so a new session can create collections again', () => {
    const win = loadCollections();
    const cap = win.Collections.MAX_COLLECTIONS_PER_SESSION;
    for (let i = 0; i < cap + 50; i++) win.Collections.createNew();
    assert.equal(win.Collections.list().length, cap);
    win.Collections.reset();
    assert.equal(win.Collections.list().length, 0);
    win.Collections.createNew();
    assert.equal(win.Collections.list().length, 1);
});
