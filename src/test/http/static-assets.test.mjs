/**
 * Smoke tests for the four static-mount points in server.js:
 *   /            → public/
 *   /vendor      → public/vendor/
 *   /scribe      → public/vendor/scribe.js-ocr/
 *   /tessdata    → public/vendor/tessdata/
 * Verifies a known file from each returns 200 and a sane content-type,
 * and that path traversal is blocked.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(() => stopServer(srv.proc));

test('root static mount serves send.html', async () => {
    const res = await fetch(`${srv.baseUrl}/send.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /html/);
});

test('/vendor serves client-zip.js', async () => {
    const res = await fetch(`${srv.baseUrl}/vendor/client-zip.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /javascript/);
});

test('/scribe serves scribe.js', async () => {
    const res = await fetch(`${srv.baseUrl}/scribe/scribe.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /javascript/);
});

test('/tessdata serves eng.traineddata', async () => {
    const res = await fetch(`${srv.baseUrl}/tessdata/eng.traineddata`);
    assert.equal(res.status, 200);
    // Binary file — content-length should be non-trivial
    const len = Number(res.headers.get('content-length') || 0);
    assert.ok(len > 1000, `expected substantial file, got ${len} bytes`);
});

test('path traversal under /vendor is blocked', async () => {
    // Express normalizes the URL; a traversal escape attempt should not
    // leak files outside the mount. Both 403 and 404 are acceptable —
    // anything other than 200 with server.js contents is fine.
    const res = await fetch(`${srv.baseUrl}/vendor/../server.js`);
    assert.notEqual(res.status, 200);
});

test('missing static file returns 404', async () => {
    const res = await fetch(`${srv.baseUrl}/vendor/does-not-exist.js`);
    assert.equal(res.status, 404);
});
