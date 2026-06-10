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

test('discardIfEmpty() removes a collection that never received an image', () => {
    const win = loadCollections();
    const id = win.Collections.createNew();
    assert.equal(win.Collections.list().length, 1);
    assert.ok(
        win.document.querySelector(`.collection-section[data-collection-id="${id}"]`),
        'section should be rendered',
    );

    const removed = win.Collections.discardIfEmpty(id);
    assert.equal(removed, true, 'an empty collection should be discarded');
    assert.equal(win.Collections.list().length, 0, 'collections array emptied');
    assert.equal(
        win.document.querySelector(`.collection-section[data-collection-id="${id}"]`),
        null,
        'the empty Document section should be removed from the DOM',
    );
    assert.equal(win.Collections.activeId(), null, 'no active collection remains');
});

test('discardIfEmpty() keeps a collection that has at least one image', () => {
    const win = loadCollections();
    const id = win.Collections.createNew();
    // Simulate a received image landing in the collection.
    win.Collections.getById(id).images.push({ hash: 'abc' });

    const removed = win.Collections.discardIfEmpty(id);
    assert.equal(removed, false, 'a non-empty collection must not be discarded');
    assert.equal(win.Collections.list().length, 1);
    assert.ok(
        win.document.querySelector(`.collection-section[data-collection-id="${id}"]`),
        'the section must still be present',
    );
});

test('discardIfEmpty() treats all-nulled images (deleted) as empty', () => {
    const win = loadCollections();
    const id = win.Collections.createNew();
    // An image was received then deleted: removeImageFromOwningCollection
    // nulls the slot rather than splicing it out.
    win.Collections.getById(id).images.push(null);

    assert.equal(win.Collections.discardIfEmpty(id), true,
        'a collection whose only image slot is null counts as empty');
    assert.equal(win.Collections.list().length, 0);
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
