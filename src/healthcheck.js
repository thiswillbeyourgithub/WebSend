/**
 * Docker healthcheck script for WebSend.
 * Tests liveness of configured STUN/TURN/TURNS servers.
 * Only checks services that are actually enabled via environment variables.
 * Also verifies the Express server is responding.
 *
 * Exit 0 = healthy, exit 1 = unhealthy.
 *
 * Generated with the help of Claude Code.
 */

const http = require('http');
const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

// Same env vars as server.js
const STUN_SERVER = process.env.STUN_SERVER || '';
const STUN_GOOGLE_FALLBACK = process.env.STUN_GOOGLE_FALLBACK !== 'false';
const TURN_SERVER = process.env.TURN_SERVER || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURNS_PORT = process.env.TURNS_PORT || '';

const TIMEOUT_MS = 5000;

// ──────────────────── STUN helpers ────────────────────

/**
 * Build a minimal STUN Binding Request (RFC 5389).
 * 20-byte header: type (2) + length (2) + magic cookie (4) + transaction ID (12).
 */
function buildStunBindingRequest() {
    const buf = Buffer.alloc(20);
    buf.writeUInt16BE(0x0001, 0);       // Binding Request
    buf.writeUInt16BE(0, 2);            // Message length (no attributes)
    buf.writeUInt32BE(0x2112A442, 4);   // Magic cookie
    crypto.randomBytes(12).copy(buf, 8); // Transaction ID
    return buf;
}

/**
 * Send a STUN Binding Request over UDP and check for a valid response.
 */
function checkStun(host, port, label) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        const timer = setTimeout(() => {
            socket.close();
            resolve({ ok: false, label, error: 'timeout' });
        }, TIMEOUT_MS);

        socket.on('message', (msg) => {
            clearTimeout(timer);
            socket.close();
            // A valid STUN response starts with 0x0101 (Binding Success) and has the magic cookie
            const type = msg.readUInt16BE(0);
            const cookie = msg.readUInt32BE(4);
            if (type === 0x0101 && cookie === 0x2112A442) {
                resolve({ ok: true, label });
            } else {
                resolve({ ok: false, label, error: `unexpected response type 0x${type.toString(16)}` });
            }
        });

        socket.on('error', (err) => {
            clearTimeout(timer);
            socket.close();
            resolve({ ok: false, label, error: err.message });
        });

        const req = buildStunBindingRequest();
        socket.send(req, port, host);
    });
}

// ──────────────────── TURN helpers ────────────────────

/**
 * Build a TURN Allocate Request with credentials (RFC 5766 / coturn ephemeral).
 * We send a bare Allocate first; a 401 with a valid STUN error response
 * is enough to confirm the server is alive and speaking TURN.
 */
function buildTurnAllocateRequest() {
    const buf = Buffer.alloc(20);
    buf.writeUInt16BE(0x0003, 0);       // Allocate Request
    buf.writeUInt16BE(0, 2);            // No attributes (will trigger 401)
    buf.writeUInt32BE(0x2112A442, 4);   // Magic cookie
    crypto.randomBytes(12).copy(buf, 8);
    return buf;
}

/**
 * Check TURN over UDP — a 401 (Unauthorized) error response means the server is alive.
 */
function checkTurn(host, port, label) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        const timer = setTimeout(() => {
            socket.close();
            resolve({ ok: false, label, error: 'timeout' });
        }, TIMEOUT_MS);

        socket.on('message', (msg) => {
            clearTimeout(timer);
            socket.close();
            const type = msg.readUInt16BE(0);
            const cookie = msg.readUInt32BE(4);
            if (cookie !== 0x2112A442) {
                resolve({ ok: false, label, error: 'not a STUN/TURN response' });
                return;
            }
            // 0x0113 = Allocate Error Response — expected (401 Unauthorized)
            // 0x0103 = Allocate Success Response — also fine
            if (type === 0x0113 || type === 0x0103) {
                resolve({ ok: true, label });
            } else {
                resolve({ ok: false, label, error: `unexpected response type 0x${type.toString(16)}` });
            }
        });

        socket.on('error', (err) => {
            clearTimeout(timer);
            socket.close();
            resolve({ ok: false, label, error: err.message });
        });

        const req = buildTurnAllocateRequest();
        socket.send(req, port, host);
    });
}

/**
 * Check TURNS (TURN-over-TLS) — connect via TLS and send an Allocate Request.
 * A valid STUN/TURN response (even 401) means the service is alive.
 */
function checkTurns(host, port, label) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            socket.destroy();
            resolve({ ok: false, label, error: 'timeout' });
        }, TIMEOUT_MS);

        const socket = tls.connect(port, host, { rejectUnauthorized: false }, () => {
            socket.write(buildTurnAllocateRequest());
        });

        socket.on('data', (msg) => {
            clearTimeout(timer);
            socket.destroy();
            if (msg.length < 8) {
                resolve({ ok: false, label, error: 'response too short' });
                return;
            }
            const cookie = msg.readUInt32BE(4);
            if (cookie === 0x2112A442) {
                resolve({ ok: true, label });
            } else {
                resolve({ ok: false, label, error: 'not a STUN/TURN response' });
            }
        });

        socket.on('error', (err) => {
            clearTimeout(timer);
            socket.destroy();
            resolve({ ok: false, label, error: err.message });
        });
    });
}

// ──────────────────── HTTP liveness ────────────────────

/**
 * Check that the Express server responds on /api/config.
 */
function checkHttp() {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve({ ok: false, label: 'HTTP /api/config', error: 'timeout' });
        }, TIMEOUT_MS);

        const req = http.get('http://localhost:8080/api/config', (res) => {
            clearTimeout(timer);
            if (res.statusCode === 200) {
                resolve({ ok: true, label: 'HTTP /api/config' });
            } else {
                resolve({ ok: false, label: 'HTTP /api/config', error: `status ${res.statusCode}` });
            }
            res.resume(); // drain
        });

        req.on('error', (err) => {
            clearTimeout(timer);
            resolve({ ok: false, label: 'HTTP /api/config', error: err.message });
        });
    });
}

// ──────────────────── Main ────────────────────

function parseHostPort(str, defaultPort) {
    const match = str.match(/^([^:]+):(\d+)$/);
    if (match) return { host: match[1], port: parseInt(match[2], 10) };
    return { host: str, port: defaultPort };
}

async function main() {
    const checks = [];

    // Always check the Express server
    checks.push(checkHttp());

    // Self-hosted STUN
    if (STUN_SERVER) {
        const { host, port } = parseHostPort(STUN_SERVER, 3478);
        checks.push(checkStun(host, port, `STUN ${STUN_SERVER}`));
    }

    // Google STUN fallback
    if (STUN_GOOGLE_FALLBACK) {
        checks.push(checkStun('stun.l.google.com', 19302, 'STUN Google'));
    }

    // TURN (UDP)
    if (TURN_SERVER && TURN_SECRET) {
        const { host, port } = parseHostPort(TURN_SERVER, 3478);
        checks.push(checkTurn(host, port, `TURN ${TURN_SERVER}`));
    }

    // TURNS (TLS)
    if (TURN_SERVER && TURN_SECRET && TURNS_PORT) {
        const { host } = parseHostPort(TURN_SERVER, 3478);
        checks.push(checkTurns(host, parseInt(TURNS_PORT, 10), `TURNS ${host}:${TURNS_PORT}`));
    }

    const results = await Promise.all(checks);

    let healthy = true;
    for (const r of results) {
        if (r.ok) {
            console.log(`✓ ${r.label}`);
        } else {
            console.log(`✗ ${r.label}: ${r.error}`);
            healthy = false;
        }
    }

    process.exit(healthy ? 0 : 1);
}

main();
