/**
 * Unit tests for public/service-worker.js, focused on the supply-chain
 * tightening: cross-origin requests must NOT be intercepted (so a
 * future Umami / CDN compromise cannot persist in user caches), and
 * even same-origin responses must only be cached when they are basic
 * (200, non-opaque, same-origin). The SW relies on a small set of
 * worker globals; we synthesize them in a sandbox and drive the
 * registered listeners directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const swSource = readFileSync(
    path.resolve(__dirname, '../../public/service-worker.js'),
    'utf8'
);

function makeSwContext({ fetchImpl }) {
    const listeners = {};
    const cachePut = [];
    const cacheStore = new Map();
    const fakeCaches = {
        open: async () => ({
            put: async (req, resp) => { cachePut.push({ req, resp }); cacheStore.set(req.url, resp); },
            addAll: async () => {},
        }),
        match: async (req) => cacheStore.get(req.url || req),
        keys: async () => [],
        delete: async () => true,
    };
    const self = {
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting: () => {},
        clients: { claim: () => {} },
        location: { origin: 'https://example.org' },
        caches: fakeCaches,
    };
    const ctx = vm.createContext({
        self,
        caches: fakeCaches,
        fetch: fetchImpl,
        URL,
        Promise,
        console: { log: () => {} },
    });
    vm.runInContext(swSource, ctx);
    return { listeners, cachePut, cacheStore };
}

function makeRequest(url, { method = 'GET' } = {}) {
    return { url, method };
}

// Drives the fetch listener and resolves whatever `respondWith` was
// called with (or undefined if the SW chose not to respond).
async function runFetchListener(listener, request) {
    let captured;
    const event = {
        request,
        respondWith: (p) => { captured = p; },
    };
    listener(event);
    return captured ? await captured : undefined;
}

test('SW skips cross-origin requests entirely (no respondWith, no cache write)', async () => {
    let fetchCalls = 0;
    const { listeners, cachePut } = makeSwContext({
        fetchImpl: async () => { fetchCalls++; return { ok: true, type: 'basic', clone: () => ({}) }; },
    });
    const result = await runFetchListener(
        listeners.fetch,
        makeRequest('https://umami.example.org/getinfo')
    );
    assert.equal(result, undefined, 'must not call respondWith for cross-origin');
    assert.equal(fetchCalls, 0, 'must not fetch through the SW for cross-origin');
    assert.equal(cachePut.length, 0, 'must not write cross-origin to cache');
});

test('SW skips non-GET requests', async () => {
    const { listeners } = makeSwContext({ fetchImpl: async () => ({}) });
    const result = await runFetchListener(
        listeners.fetch,
        makeRequest('https://example.org/api/rooms', { method: 'POST' })
    );
    assert.equal(result, undefined);
});

test('SW does not cache opaque responses (type !== basic) even when same-origin', async () => {
    const opaqueResp = { ok: true, type: 'opaque', clone: () => opaqueResp };
    const { listeners, cachePut } = makeSwContext({
        fetchImpl: async () => opaqueResp,
    });
    await runFetchListener(
        listeners.fetch,
        makeRequest('https://example.org/js/foo.js')
    );
    assert.equal(cachePut.length, 0, 'opaque same-origin response must NOT be cached');
});

test('SW caches successful same-origin basic response', async () => {
    const goodResp = { ok: true, type: 'basic', clone: () => goodResp };
    const { listeners, cachePut } = makeSwContext({
        fetchImpl: async () => goodResp,
    });
    const result = await runFetchListener(
        listeners.fetch,
        makeRequest('https://example.org/js/foo.js')
    );
    assert.equal(result, goodResp, 'response must be returned to caller');
    assert.equal(cachePut.length, 1, 'one cache write expected');
});

test('SW network-only on /api/* (no cache write even if response basic)', async () => {
    const goodResp = { ok: true, type: 'basic', clone: () => goodResp };
    const { listeners, cachePut } = makeSwContext({
        fetchImpl: async () => goodResp,
    });
    await runFetchListener(
        listeners.fetch,
        makeRequest('https://example.org/api/config')
    );
    assert.equal(cachePut.length, 0, '/api/* responses must never be cached');
});
