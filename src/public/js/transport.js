/**
 * transport.js — transport-agnostic abstraction over the peer connection.
 *
 * The receiver and sender flows talk to a "Transport" instance rather than
 * directly to a WebRTC peer connection. This lets us swap or race multiple
 * underlying transports (today: WebRTC only; commit 3 adds WebSocket; commit
 * 4 adds long-poll HTTP fallback for corporate networks that block both
 * UDP and TLS-over-non-443).
 *
 * The Transport interface is duck-typed and mirrors the public surface that
 * webrtc.js (`WebSendRTC`) has always exposed, so existing consumers do not
 * need to learn a new contract.
 *
 *   Lifecycle
 *     async init()                       — fetch /api/config, prepare ICE servers
 *     async createOfferAndStore()        — receiver flow, returns {roomId, secret}
 *     async waitForAnswer()              — receiver flow, long-polls until peer joins
 *     async joinRoom(roomId, secret)     — sender flow
 *     close()                            — tear down
 *
 *   Data plane
 *     sendMessage(obj) -> boolean        — JSON control message
 *     async sendFile(bytes, onProgress)  — chunked binary, awaits file-ack
 *
 *   Events (callback fields, set by the caller)
 *     onConnected()
 *     onDisconnected()
 *     onStateChange(state)
 *     onMessage(msg)
 *     onConnectionTypeDetected({type, details, localType, remoteType})
 *
 *   State
 *     iceServers                         — array, used by PeerUI.hasTurn() check
 *     receiveBuffer                      — kept for the receiver-flow shred path
 *     pc                                 — used by visibilitychange probe in sender-connect
 *
 * The minimal commit-1 implementation returns a bare WebSendRTC instance from
 * each factory. Later commits introduce ws-transport.js, lp-transport.js, and
 * a RacingTransport wrapper that opens multiple inner transports in parallel
 * and picks the first one to actually connect (favouring WebRTC with a 10s
 * grace window per the design doc).
 *
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    function createForReceiver() {
        return new window.WebSendRTC();
    }

    function createForSender() {
        return new window.WebSendRTC();
    }

    // Frozen so a hostile script cannot swap the factories with one that
    // returns a tampered transport (e.g. one whose sendMessage silently
    // drops fingerprint-confirmed, or whose isVerified always returns
    // true). Matches the freeze of WebSendCrypto/Protocol/SenderConnect.
    window.Transport = Object.freeze({
        createForReceiver,
        createForSender,
    });
})();
