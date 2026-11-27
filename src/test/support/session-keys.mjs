/**
 * Derive a real receiver/sender session-key pair with
 * WebSendCrypto.deriveSessionKeys (ECDH + QR secret K + both public keys),
 * the way pairing.js does in production. Shared by every unit test that
 * needs matching keys so the binding shape lives in one place.
 *
 * `override.receiver` / `override.sender` patch one side's binding (other
 * K, swapped keys) to model a mismatched QR or a MITM.
 *
 * Built with Claude Code (Opus 5.5).
 */
export async function makeSessionPair(C, override = {}) {
    const kpR = await C.generateKeyPair();
    const kpS = await C.generateKeyPair();
    const pubR = await C.exportPublicKey(kpR.publicKey);
    const pubS = await C.exportPublicKey(kpS.publicKey);
    const qrSecret = C.generateQrSecret();
    const binding = { receiverPub: pubR, senderPub: pubS, qrSecret };
    const receiverKeys = await C.deriveSessionKeys(
        kpR.privateKey, await C.importPublicKey(pubS), { ...binding, ...(override.receiver || {}) });
    const senderKeys = await C.deriveSessionKeys(
        kpS.privateKey, await C.importPublicKey(pubR), { ...binding, ...(override.sender || {}) });
    return { receiverKeys, senderKeys, pubR, pubS, qrSecret };
}
