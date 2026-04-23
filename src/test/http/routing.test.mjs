import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(() => stopServer(srv.proc));

test('/send/:roomId serves send.html', async () => {
    const res = await fetch(`${srv.baseUrl}/send/ABC123`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<!DOCTYPE html/i, 'Not an HTML response');
    assert.match(html, /<title>WebSend - Send Photos<\/title>/, 'Expected send.html title');
});

test('/receive.html serves receive.html', async () => {
    const res = await fetch(`${srv.baseUrl}/receive.html`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<!DOCTYPE html/i, 'Not an HTML response');
    assert.match(html, /<title>WebSend - Receive Photos<\/title>/, 'Expected receive.html title');
});

test('static file /js/transfer-stats.js is served', async () => {
    const res = await fetch(`${srv.baseUrl}/js/transfer-stats.js`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('javascript'), 'Expected JS content-type');
});
