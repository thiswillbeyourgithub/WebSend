/**
 * Shared helper: spawn the real Express server on a random port and tear it down after tests.
 * Usage: call startServer() in before(), stopServer() in after().
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.resolve(__dirname, '../../server.js');

export function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

export async function startServer(env = {}) {
    const port = await getFreePort();
    const proc = spawn('node', [SERVER_JS], {
        env: {
            ...process.env,
            PORT: String(port),
            DOMAIN: 'localhost',
            DEV_FORCE_CONNECTION: 'DIRECT',
            // Disable STUN/TURN for HTTP tests
            STUN_GOOGLE_FALLBACK: 'false',
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait until the server is ready (prints its listen message)
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Server start timeout')), 5000);
        proc.stdout.on('data', (data) => {
            if (data.toString().includes(String(port)) || data.toString().includes('listening')) {
                clearTimeout(timeout);
                resolve();
            }
        });
        proc.stderr.on('data', (data) => {
            // Also check stderr for listen messages
            if (data.toString().includes(String(port)) || data.toString().includes('listening')) {
                clearTimeout(timeout);
                resolve();
            }
        });
        proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
        proc.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited with ${code}`)); });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    return { proc, port, baseUrl };
}

export function stopServer(proc) {
    return new Promise((resolve) => {
        proc.on('exit', resolve);
        proc.kill('SIGTERM');
    });
}

export async function createRoom(baseUrl, origin) {
    const res = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
    });
    return res.json();
}

// Long-poll relay endpoint wrappers, shared by relay-lp.test.mjs and the
// cross-kind (WS sender -> LP receiver) tests in relay-ws.test.mjs.

export function lpHandshake(baseUrl, roomId, secret) {
    return fetch(`${baseUrl}/api/rooms/${roomId}/relay/handshake`, {
        method: 'POST',
        headers: { 'X-Room-Secret': secret, 'Content-Type': 'application/json' },
        body: '{}',
    });
}

export function lpUp(baseUrl, roomId, secret, token, body, isBinary) {
    return fetch(`${baseUrl}/api/rooms/${roomId}/relay/up`, {
        method: 'POST',
        headers: {
            'X-Room-Secret': secret,
            'X-Slot-Token': token,
            // text/plain (not application/json) so the global express.json()
            // body parser doesn't intercept the body before our route's raw
            // parser; matches what lp-transport.js sends from the browser.
            'Content-Type': isBinary ? 'application/octet-stream' : 'text/plain',
        },
        body,
    });
}

export function lpDown(baseUrl, roomId, secret, token, wait = false) {
    const url = `${baseUrl}/api/rooms/${roomId}/relay/down${wait ? '?wait=true' : ''}`;
    return fetch(url, {
        method: 'GET',
        headers: { 'X-Room-Secret': secret, 'X-Slot-Token': token },
    });
}
