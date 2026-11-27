/**
 * Pairing state machine shared by the browser receiver (receive.html), the
 * browser sender (sender-connect.js) and the CLI receiver (cli/shim.js).
 * Exposes window.Pairing (frozen).
 *
 * Flow, per side:
 *   1. acceptPeerKey(msg) with the peer's public-key / sender-public-key
 *      message: checks the protocol version, derives the session keys
 *      (ECDH + QR secret K + both public keys, see
 *      WebSendCrypto.deriveSessionKeys) and returns our key-confirm message
 *      for the caller to send.
 *   2. handleKeyConfirm(msg) with the peer's key-confirm: the session binds
 *      only when it opens under the peer-direction confirm key. A confirm
 *      arriving before derivation finished is buffered and processed once
 *      the keys exist (message dispatch is not awaited).
 *
 * "Bound" is the single gate that replaces the old human verification
 * modal: getSessionKeys() returns null until bound, so no file can be
 * decrypted (receiver) or sent (sender) before the peer proved it derived
 * the same keys, which a signaling MITM without K cannot do.
 *
 * Built with Claude Code (Opus 5.5).
 */
(function () {
    const DIRECTIONS = {
        receiver: { ours: 'receiver-to-sender', peer: 'sender-to-receiver' },
        sender: { ours: 'sender-to-receiver', peer: 'receiver-to-sender' },
    };
    // Generous: both sides send their confirm right after deriving, so on a
    // healthy link it arrives within one RTT. Expiry means the peer derived
    // different keys and stayed silent, or never answered.
    const KEY_CONFIRM_TIMEOUT_MS = 30000;

    /**
     * @param {Object} opts
     * @param {'receiver'|'sender'} opts.role
     * @param {{publicKey: CryptoKey, privateKey: CryptoKey}} opts.keyPair
     * @param {string} opts.qrSecret - K (22-char base64url); never logged
     * @param {function()} [opts.onBound] - Peer confirm opened; session usable
     * @param {function(string)} [opts.onFailed] - Reason: 'confirm-mismatch' | 'timeout'
     * @param {number} [opts.confirmTimeoutMs]
     */
    function create(opts) {
        const { role, keyPair, qrSecret } = opts;
        const dirs = DIRECTIONS[role];
        if (!dirs) throw new Error(`Pairing: unknown role ${role}`);
        if (!window.WebSendCrypto.isQrSecret(qrSecret)) throw new Error('Pairing: invalid QR secret');
        const onBound = opts.onBound || (() => {});
        const onFailed = opts.onFailed || (() => {});
        const timeoutMs = opts.confirmTimeoutMs || KEY_CONFIRM_TIMEOUT_MS;

        let ourPubB64 = null;
        let peerPubB64 = null;
        let sessionKeys = null;   // derived, possibly not yet bound
        let derivePromise = null;
        let bound = false;
        let failed = false;
        let pendingCt = null;     // confirm received before keys existed
        let generation = 0;       // bumps on reset/re-key; stale async work bails
        let timer = null;

        function clearTimer() {
            if (timer) { clearTimeout(timer); timer = null; }
        }

        function fail(reason) {
            if (failed) return;
            failed = true;
            bound = false;
            clearTimer();
            onFailed(reason);
        }

        async function processConfirm(ct, gen) {
            const ok = await sessionKeys.openKeyConfirm(dirs.peer, ct);
            if (gen !== generation || failed) return { status: 'stale' };
            if (ok) {
                if (bound) return { status: 'bound', newlyBound: false };
                bound = true;
                clearTimer();
                onBound();
                return { status: 'bound', newlyBound: true };
            }
            // A bad confirm on an already bound session cannot unbind it
            // (the peer already proved key possession); just ignore it.
            if (bound) return { status: 'ignored' };
            fail('confirm-mismatch');
            return { status: 'failed' };
        }

        async function sealOurConfirm() {
            return window.Protocol.build.keyConfirm(await sessionKeys.sealKeyConfirm(dirs.ours));
        }

        /**
         * Accept the peer's public key message.
         * Resolves to one of:
         *   { status: 'version-mismatch' }  peer runs another protocol version
         *   { status: 'invalid-key' }       key failed validation
         *   { status: 'same-key', confirmMsg } duplicate of the current key;
         *     state kept, confirmMsg is a fresh seal of our confirm to re-send
         *   { status: 'derived', confirmMsg, rekey } keys derived for this key
         *     (rekey = a different key replaced a previous one; any binding
         *     was dropped synchronously before the first await)
         *   { status: 'stale' }             superseded by a reset / newer key
         */
        async function acceptPeerKey(msg) {
            if (!window.Protocol.isCompatibleVersion(msg)) return { status: 'version-mismatch' };
            const b64 = msg.key;
            try {
                window.WebSendCrypto.decodePublicKeyBytes(b64);
            } catch (e) {
                return { status: 'invalid-key' };
            }
            if (peerPubB64 === b64 && derivePromise) {
                await derivePromise;
                if (peerPubB64 !== b64 || !sessionKeys) return { status: 'stale' };
                return { status: 'same-key', confirmMsg: await sealOurConfirm() };
            }

            // New or different peer key: drop everything synchronously so no
            // gate can pass on the old binding while we derive.
            const rekey = peerPubB64 !== null;
            const gen = ++generation;
            peerPubB64 = b64;
            sessionKeys = null;
            bound = false;
            failed = false;
            clearTimer();

            derivePromise = (async () => {
                if (!ourPubB64) ourPubB64 = await window.WebSendCrypto.exportPublicKey(keyPair.publicKey);
                const theirKey = await window.WebSendCrypto.importPublicKey(b64);
                const binding = role === 'receiver'
                    ? { receiverPub: ourPubB64, senderPub: b64, qrSecret }
                    : { receiverPub: b64, senderPub: ourPubB64, qrSecret };
                return window.WebSendCrypto.deriveSessionKeys(keyPair.privateKey, theirKey, binding);
            })();
            const keys = await derivePromise;
            if (gen !== generation) return { status: 'stale' };
            sessionKeys = keys;
            timer = setTimeout(() => { if (gen === generation && !bound) fail('timeout'); }, timeoutMs);

            const confirmMsg = await sealOurConfirm();
            if (gen !== generation) return { status: 'stale' };
            if (pendingCt !== null) {
                const ct = pendingCt;
                pendingCt = null;
                // Fire-and-forget: the result surfaces via onBound/onFailed.
                processConfirm(ct, gen);
            }
            return { status: 'derived', confirmMsg, rekey };
        }

        /**
         * Handle the peer's key-confirm message (already Protocol.validate'd).
         * Resolves to { status: 'pending' | 'bound' | 'failed' | 'ignored' | 'stale', newlyBound? }.
         */
        async function handleKeyConfirm(msg) {
            if (failed) return { status: 'failed' };
            if (!sessionKeys) {
                // Keys not ready yet (or no peer key at all): keep the latest
                // confirm and evaluate it when derivation completes.
                pendingCt = msg.ct;
                return { status: 'pending' };
            }
            return processConfirm(msg.ct, generation);
        }

        /** Forget the peer entirely (new pairing, cleanup, peer refused). */
        function reset() {
            generation++;
            peerPubB64 = null;
            sessionKeys = null;
            derivePromise = null;
            bound = false;
            failed = false;
            pendingCt = null;
            clearTimer();
        }

        return Object.freeze({
            acceptPeerKey,
            handleKeyConfirm,
            reset,
            isBound: () => bound,
            hasFailed: () => failed,
            hasPeerKey: () => peerPubB64 !== null,
            isSamePeerKey: (b64) => peerPubB64 !== null && peerPubB64 === b64,
            getSessionKeys: () => (bound ? sessionKeys : null),
        });
    }

    window.Pairing = Object.freeze({ create, KEY_CONFIRM_TIMEOUT_MS });
})();
