/**
 * Verifies that the defensive HTTP headers added in server.js are
 * actually attached to every response (HTML page, API JSON, static
 * vendor file, 404). These headers are defense-in-depth: a regression
 * that drops them would silently re-enable XSS / clickjacking / cross-
 * origin embedding vectors that future code changes could otherwise
 * introduce.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(() => stopServer(srv.proc));

const REQUIRED = [
    ['content-security-policy', /default-src 'self'/],
    ['content-security-policy', /frame-ancestors 'none'/],
    ['content-security-policy', /object-src 'none'/],
    ['content-security-policy', /form-action 'none'/],
    ['x-content-type-options', /^nosniff$/],
    ['x-frame-options', /^DENY$/],
    ['referrer-policy', /^no-referrer$/],
    ['cross-origin-opener-policy', /^same-origin$/],
    ['cross-origin-resource-policy', /^same-origin$/],
];

async function assertAllPresent(url) {
    const res = await fetch(url);
    for (const [hdr, re] of REQUIRED) {
        const v = res.headers.get(hdr) || '';
        assert.match(v, re, `${url} missing or wrong ${hdr} (got: "${v}")`);
    }
}

test('HTML page carries the full security-header set', async () => {
    await assertAllPresent(`${srv.baseUrl}/send.html`);
});

test('API JSON response carries the full security-header set', async () => {
    await assertAllPresent(`${srv.baseUrl}/api/config`);
});

test('Static vendor asset carries the full security-header set', async () => {
    await assertAllPresent(`${srv.baseUrl}/vendor/client-zip.js`);
});

test('CSP includes the Umami origin in script-src/connect-src when configured', async () => {
    // Spin up a second server with Umami env wired so we can confirm the
    // CSP rewrite path: without this the analytics tracker (loaded from
    // a different origin and POSTing back) is silently blocked by our
    // strict default `script-src 'self'` / `connect-src 'self'`.
    const srv2 = await startServer({
        UMAMI_URL: 'https://umami.example.org',
        UMAMI_WEBSITE_ID: 'abc-123',
        UMAMI_DNT: 'true',
    });
    try {
        const res = await fetch(`${srv2.baseUrl}/api/config`);
        const csp = res.headers.get('content-security-policy') || '';
        assert.match(csp, /script-src [^;]*https:\/\/umami\.example\.org/,
            `script-src must include the Umami origin (got: "${csp}")`);
        assert.match(csp, /connect-src [^;]*https:\/\/umami\.example\.org/,
            `connect-src must include the Umami origin (got: "${csp}")`);
    } finally {
        await stopServer(srv2.proc);
    }
});

test('404 response carries a CSP at least as restrictive as ours', async () => {
    // serve-static's built-in 404 page sets its own (stricter) CSP
    // (default-src 'none') so the body is rendered with no powers at
    // all. That's safer than our 'self' baseline, so accept either.
    const res = await fetch(`${srv.baseUrl}/this/path/does/not/exist`);
    assert.equal(res.status, 404);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(
        /default-src 'self'/.test(csp) || /default-src 'none'/.test(csp),
        `404 must carry a CSP, got: "${csp}"`
    );
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
