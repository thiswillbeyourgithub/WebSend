/**
 * AUTH_SCOPE=receiver (asymmetric / receiver-only auth) behaviour.
 *
 * The feature lets a deployment require SSO for the RECEIVER (who creates the
 * room) while leaving the SENDER on a separate open host. The load-bearing
 * in-app control is the room-creation gate: POST /api/rooms is refused unless
 * the request carries the trusted identity header the auth proxy injects after
 * login. These tests pin that gate, the /api/config.senderOrigin surfacing, the
 * default 'both' mode staying inert, and the fail-closed startup validation.
 *
 * Each test spawns its own server because AUTH_SCOPE / SENDER_PUBLIC_ORIGIN are
 * read once at boot. Generated with the help of Claude Code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

const SENDER = 'https://send.example';
// Receiver mode needs the sender origin whitelisted, plus the gated receiver
// origin the room-creation POST is issued from.
const RECEIVER_ENV = {
    AUTH_SCOPE: 'receiver',
    SENDER_PUBLIC_ORIGIN: SENDER,
    ALLOWED_ORIGINS: `https://localhost,${SENDER}`,
    TEST_DISABLE_RATE_LIMIT: '1',
};

async function postRoom(baseUrl, headers = {}) {
    return fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: '{}',
    });
}

test('default AUTH_SCOPE=both: room creation is open and senderOrigin is null', async () => {
    const srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1' });
    try {
        const cfg = await (await fetch(`${srv.baseUrl}/api/config`)).json();
        assert.equal(cfg.senderOrigin, null, 'senderOrigin should be null in both mode');

        const res = await postRoom(srv.baseUrl);
        assert.equal(res.status, 200, 'room creation must stay open in both mode');
        const body = await res.json();
        assert.ok(typeof body.roomId === 'string' && body.roomId.length === 6, `Bad roomId: ${body.roomId}`);
    } finally {
        await stopServer(srv.proc);
    }
});

test('receiver mode: /api/config surfaces the configured senderOrigin', async () => {
    const srv = await startServer(RECEIVER_ENV);
    try {
        const cfg = await (await fetch(`${srv.baseUrl}/api/config`)).json();
        assert.equal(cfg.senderOrigin, SENDER);
    } finally {
        await stopServer(srv.proc);
    }
});

test('receiver mode: POST /api/rooms without an identity header is refused (401)', async () => {
    const srv = await startServer(RECEIVER_ENV);
    try {
        const res = await postRoom(srv.baseUrl);
        assert.equal(res.status, 401, 'room creation must require auth in receiver mode');
        const body = await res.json();
        assert.match(body.error, /[Aa]uthentication required/);
    } finally {
        await stopServer(srv.proc);
    }
});

test('receiver mode: POST /api/rooms with the proxy identity header succeeds', async () => {
    const srv = await startServer(RECEIVER_ENV);
    try {
        const res = await postRoom(srv.baseUrl, { 'X-Auth-Request-User': 'alice@example.com' });
        assert.equal(res.status, 200, 'a request carrying the identity header is the authenticated path');
        const body = await res.json();
        assert.ok(typeof body.roomId === 'string' && body.roomId.length === 6, `Bad roomId: ${body.roomId}`);
    } finally {
        await stopServer(srv.proc);
    }
});

test('receiver mode: a blank identity header does not satisfy the gate', async () => {
    const srv = await startServer(RECEIVER_ENV);
    try {
        const res = await postRoom(srv.baseUrl, { 'X-Auth-Request-User': '   ' });
        assert.equal(res.status, 401, 'whitespace-only identity must fail closed');
    } finally {
        await stopServer(srv.proc);
    }
});

test('receiver mode: AUTH_IDENTITY_HEADER is configurable', async () => {
    const srv = await startServer({ ...RECEIVER_ENV, AUTH_IDENTITY_HEADER: 'X-Forwarded-User' });
    try {
        // The default header is now ignored; only the configured one counts.
        const ignored = await postRoom(srv.baseUrl, { 'X-Auth-Request-User': 'alice@example.com' });
        assert.equal(ignored.status, 401, 'default header must not satisfy a custom AUTH_IDENTITY_HEADER');

        const accepted = await postRoom(srv.baseUrl, { 'X-Forwarded-User': 'alice@example.com' });
        assert.equal(accepted.status, 200, 'the configured header must be honored');
    } finally {
        await stopServer(srv.proc);
    }
});

test('startup aborts when AUTH_SCOPE=receiver but SENDER_PUBLIC_ORIGIN is unset', async () => {
    await assert.rejects(
        startServer({ AUTH_SCOPE: 'receiver' }),
        /exited/,
        'server must refuse to boot without a sender origin',
    );
});

test('startup aborts when SENDER_PUBLIC_ORIGIN is not in ALLOWED_ORIGINS', async () => {
    await assert.rejects(
        startServer({
            AUTH_SCOPE: 'receiver',
            SENDER_PUBLIC_ORIGIN: SENDER,
            ALLOWED_ORIGINS: 'https://localhost', // SENDER deliberately absent
        }),
        /exited/,
        'an un-whitelisted sender origin would have its API calls rejected; fail fast',
    );
});

test('startup aborts on an invalid AUTH_SCOPE value', async () => {
    await assert.rejects(
        startServer({ AUTH_SCOPE: 'nonsense' }),
        /exited/,
        'only both|receiver are valid',
    );
});
