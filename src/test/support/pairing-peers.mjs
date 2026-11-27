/**
 * Shared Pairing test fixtures: load the real crypto.js + protocol.js +
 * pairing.js into one vm context, and build a receiver/sender Pairing pair
 * wired the way receive.html and sender-connect.js wire theirs.
 *
 * Built with Claude Code (Opus 5.5).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadBrowserModule } from './load-browser-module.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const js = (f) => path.resolve(__dirname, '../../public/js', f);

/** Window with WebSendCrypto, Protocol and Pairing. */
export function loadPairingWindow() {
    return loadBrowserModule([js('crypto.js'), js('protocol.js'), js('pairing.js')], {
        TextEncoder, TextDecoder,
        btoa: globalThis.btoa, atob: globalThis.atob,
        setTimeout, clearTimeout,
    });
}

/**
 * Two Pairing instances plus their public-key messages. `senderK` /
 * `receiverK` override one side's QR secret to model a wrong link or MITM.
 * `events[role]` records 'bound' / 'failed:<reason>'.
 */
export async function makePairingPeers(win, { senderK, receiverK, timeoutMs } = {}) {
    const { WebSendCrypto: C, Protocol: P, Pairing } = win;
    const K = C.generateQrSecret();
    const kpR = await C.generateKeyPair();
    const kpS = await C.generateKeyPair();
    const events = { receiver: [], sender: [] };
    const mk = (role, keyPair, qrSecret) => Pairing.create({
        role, keyPair, qrSecret,
        confirmTimeoutMs: timeoutMs,
        onBound: () => events[role].push('bound'),
        onFailed: (reason) => events[role].push(`failed:${reason}`),
    });
    const receiver = mk('receiver', kpR, receiverK || K);
    const sender = mk('sender', kpS, senderK || K);
    const rPubMsg = P.build.publicKey(await C.exportPublicKey(kpR.publicKey));
    const sPubMsg = P.build.senderPublicKey(await C.exportPublicKey(kpS.publicKey));
    return { receiver, sender, rPubMsg, sPubMsg, events, K };
}
