/**
 * Verifies the server's final 404 and 500 handlers do not leak
 * implementation detail. Express 4's stock error handler emits the
 * full stack trace in the response body unless NODE_ENV is exactly
 * "production"; we set neither NODE_ENV nor any framework alias, so a
 * thrown exception would otherwise hand the network a tour of our
 * source layout, dependency versions, and in-memory data shape. The
 * 404 handler likewise replaces Express's text/html "Cannot GET /x"
 * page so an attacker probing arbitrary paths cannot fingerprint our
 * routing tree.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let server;

before(async () => { server = await startServer(); });
after(async () => { await stopServer(server.proc); });

test('GET /this/does/not/exist returns generic 404 JSON', async () => {
    const res = await fetch(`${server.baseUrl}/this/does/not/exist`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Not found' });
});

test('404 body does not echo the requested path', async () => {
    // Express default 404 inlines the path, which lets an attacker
    // smuggle markup or ANSI into log scrapers and proxy dashboards.
    const probe = '/__probe_<script>alert(1)</script>__';
    const res = await fetch(`${server.baseUrl}${encodeURI(probe)}`);
    const text = await res.text();
    assert.ok(!text.includes('probe'), `404 body must not echo path, got: ${text}`);
    assert.ok(!text.includes('Cannot GET'), `404 body must not include the Express default phrase`);
});

test('404 body does not include a stack trace', async () => {
    const res = await fetch(`${server.baseUrl}/__nope__`);
    const text = await res.text();
    assert.ok(!/at\s+\w.*\(.*\.js:\d+/.test(text), `404 body leaked a stack frame: ${text}`);
    assert.ok(!text.includes(process.cwd()), `404 body leaked an absolute path`);
});

test('body-parser 413 passes through with a scrubbed message', async () => {
    // The error handler must not eat well-formed 4xx status codes from
    // upstream middleware (here, body-parser's 50kb cap on JSON), but
    // must still replace err.message with a generic phrase so parser
    // fingerprints do not leak to the network.
    const huge = JSON.stringify({ pad: 'x'.repeat(60 * 1024) });
    const res = await fetch(`${server.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${server.port}` },
        body: huge,
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Payload too large' });
});

test('malformed JSON returns 400 with a scrubbed message', async () => {
    const res = await fetch(`${server.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${server.port}` },
        body: '{ not valid json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    // err.message would have been something like "Unexpected token n in
    // JSON at position 2" which fingerprints the parser version.
    assert.ok(!/JSON|token|position|SyntaxError/.test(body.error || ''),
        `400 body must not leak parser fingerprint, got: ${JSON.stringify(body)}`);
});

test('unknown method on existing path also takes the 404 path', async () => {
    // No registered handler exists for TRACE on /api/stats; it must
    // not fall through to a noisy default response.
    const res = await fetch(`${server.baseUrl}/api/stats`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Not found' });
});
