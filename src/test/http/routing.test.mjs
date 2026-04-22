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
    assert.ok(html.includes('<!DOCTYPE html') || html.includes('<html'), 'Not an HTML response');
    assert.ok(html.toLowerCase().includes('send') || html.includes('WebSend'), 'Expected send.html content');
});

test('/receive.html serves receive.html', async () => {
    const res = await fetch(`${srv.baseUrl}/receive.html`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<!DOCTYPE html') || html.includes('<html'), 'Not an HTML response');
});

test('static file /js/transfer-stats.js is served', async () => {
    const res = await fetch(`${srv.baseUrl}/js/transfer-stats.js`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('javascript'), 'Expected JS content-type');
});
