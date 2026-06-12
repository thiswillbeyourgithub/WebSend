/**
 * Unit tests for js/ws-transport.js around the sendFile entry guard.
 *
 * A sendFile on a closed socket must throw a TransientDisconnectError
 * (tagged beforeFileStart for a fresh send) instead of resolving false:
 * the falsy resolve let sender-send.js fall through to its post-transfer
 * tail and fail the queued file with "finishHash before all segments
 * were read", dropping it from the queue even though no byte ever left
 * the host.
 *
 * Generated with the help of Claude Code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadBrowserModule } from '../support/load-browser-module.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(__dirname, '../../public/js');

class TransientDisconnectError extends Error {
    constructor(message, nextSeq) {
        super(message);
        this.transient = true;
        if (Number.isInteger(nextSeq)) this.nextSeq = nextSeq;
        this.beforeFileStart = false;
    }
}

async function loadWsTransport() {
    const win = await loadBrowserModule(path.join(pub, 'ws-transport.js'), {
        PayloadAssembler: { initState: () => {} },
        TransientDisconnectError,
    });
    return new win.WSTransport();
}

test('sendFile on a closed socket throws a transient error tagged beforeFileStart', async () => {
    const t = await loadWsTransport();
    await assert.rejects(
        () => t.sendFile({ segCount: 3 }, () => {}),
        (e) => e.transient === true && e.beforeFileStart === true && e.nextSeq === 0,
        'fresh send: nothing reached the wire, so the receiver will never offer a resume'
    );
});

test('sendFile resume on a closed socket throws a transient error WITHOUT beforeFileStart', async () => {
    const t = await loadWsTransport();
    await assert.rejects(
        () => t.sendFile({ segCount: 3 }, () => {}, 2),
        (e) => e.transient === true && e.beforeFileStart === false && e.nextSeq === 2,
        'resume: the receiver holds partial state and will re-offer after the next reconnect'
    );
});
