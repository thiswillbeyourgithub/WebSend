/**
 * Tests that env vars propagate correctly to /api/config and to the Umami
 * HTML injection middleware. Each test spawns its own server because env
 * vars are read once at boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

test('ALLOWED_FILE_TYPES=ONLY_IMAGES surfaces in /api/config', async () => {
    const srv = await startServer({ ALLOWED_FILE_TYPES: 'ONLY_IMAGES' });
    try {
        const body = await (await fetch(`${srv.baseUrl}/api/config`)).json();
        assert.equal(body.allowedFileTypes, 'ONLY_IMAGES');
    } finally {
        await stopServer(srv.proc);
    }
});

test('ALLOWED_FILE_TYPES is upper-cased regardless of env casing', async () => {
    const srv = await startServer({ ALLOWED_FILE_TYPES: 'image_or_pdf' });
    try {
        const body = await (await fetch(`${srv.baseUrl}/api/config`)).json();
        assert.equal(body.allowedFileTypes, 'IMAGE_OR_PDF');
    } finally {
        await stopServer(srv.proc);
    }
});

test('BRANDING defaults to "WebSend" in /api/config when unset', async () => {
    const srv = await startServer();
    try {
        const body = await (await fetch(`${srv.baseUrl}/api/config`)).json();
        assert.equal(body.branding, 'WebSend');
    } finally {
        await stopServer(srv.proc);
    }
});

test('BRANDING is surfaced verbatim in /api/config (spaces/_/- allowed)', async () => {
    const srv = await startServer({ BRANDING: 'Acme Corp-1_x' });
    try {
        const body = await (await fetch(`${srv.baseUrl}/api/config`)).json();
        assert.equal(body.branding, 'Acme Corp-1_x');
    } finally {
        await stopServer(srv.proc);
    }
});

for (const bad of ['', 'a'.repeat(33), 'bad/name', 'no@symbols']) {
    test(`BRANDING=${JSON.stringify(bad)} aborts startup`, async () => {
        await assert.rejects(
            startServer({ BRANDING: bad }),
            /exited with 1/,
            'invalid BRANDING must crash the server, not boot with it',
        );
    });
}

test('Umami script is injected into index.html when UMAMI_URL+UMAMI_WEBSITE_ID set', async () => {
    const srv = await startServer({
        UMAMI_URL: 'https://umami.example.org',
        UMAMI_WEBSITE_ID: 'abc-123',
    });
    try {
        const html = await (await fetch(`${srv.baseUrl}/`)).text();
        assert.match(html, /umami\.example\.org\/getinfo/);
        assert.match(html, /data-website-id="abc-123"/);
        // Default UMAMI_DNT is "true"
        assert.match(html, /data-do-not-track="true"/);
    } finally {
        await stopServer(srv.proc);
    }
});

test('Umami script is NOT injected when UMAMI_URL is unset', async () => {
    const srv = await startServer(); // no UMAMI env
    try {
        const html = await (await fetch(`${srv.baseUrl}/`)).text();
        assert.doesNotMatch(html, /data-website-id=/);
    } finally {
        await stopServer(srv.proc);
    }
});
