# Architecture

> Written with the help of [Claude Code](https://claude.ai/claude-code).

## Table of Contents

- [Overview](#overview)
- [Directory Structure](#directory-structure)
- [Data Flow](#data-flow)
- [Server API Endpoints](#server-api-endpoints)
- [Threat Model](#threat-model)
- [Security Layers](#security-layers)
- [SSO (Experimental)](#sso-experimental)
- [Testing](#testing)
- [Deployment](#deployment)

## Overview

WebSend is a webapp for securely transferring files (photos, PDFs, and other documents)
from a phone (sender) to a computer (receiver). It uses WebRTC for peer-to-peer data
transfer and ECDH + AES-GCM for end-to-end encryption. The server's only role is
signaling (SDP relay) and serving static files — it never sees file data or encryption
keys. The `ALLOWED_FILE_TYPES` env var controls which file types are accepted
(`ONLY_IMAGES`, `IMAGE_OR_PDF`, or `ANY` — default: `ANY`). PDFs can be exported as
a ZIP of page images or as a searchable OCR PDF using the bundled scribe.js/MuPDF engine.
Other server-tunable knobs surfaced via `/api/config` and the startup env-var dump:
`PORT` (HTTP listen port, default `8080`), `OCR_LANGS` (Tesseract languages, default
`eng,fra`), `OCR_PSM` (page-segmentation mode, default `12`), `TURN_TIMEOUT` (TURN
ICE-gather timeout, seconds, default `15`), `DEV_FORCE_CONNECTION` (force `DIRECT` /
`RELAY_HTTPS` / `RELAY_LP` for testing, default `DEFAULT`), `RELAY_ENABLE` (expose the
HTTP-relay fallback transport, default `true`), `RELAY_LP_ONLY` (long-poll-only
transport: suppresses WebRTC ICE servers and disables the WS relay endpoint so only
the long-poll path is exposed, default `false`), and `TEST_DISABLE_RATE_LIMIT` (test
escape hatch).

## Directory Structure

```
WebSend/
├── CLAUDE.md               # Project spec and instructions for AI-assisted development
├── TODO.md                 # Task tracking
├── README.md               # User-facing docs: features, security, deployment
├── deploy.sh               # Deployment script
│
├── docker/
│   ├── Dockerfile          # Node 20 Alpine image, non-root user, production build
│   ├── docker-compose.yml  # Service definition with security hardening (read-only FS,
│   │                       #   dropped capabilities, resource limits, health check)
│   │                       #   Also contains commented-out coturn TURN relay service
│   └── env.example         # Documented env vars: DOMAIN, ICE servers, TURN credentials, ALLOWED_FILE_TYPES
│
└── src/
    ├── cli/                # Optional Node CLI receiver (advanced; not for end users).
    │   ├── receive.js      # Pairs as a receiver from a terminal; drives a headless
    │   │                   #   Playwright Chromium (already a devDep) that loads the
    │   │                   #   production crypto.js + protocol.js from the live server,
    │   │                   #   so the wire protocol cannot drift. File saves and the
    │   │                   #   y/n fingerprint prompt are bridged to Node via
    │   │                   #   page.exposeFunction. No new dependencies.
    │   ├── shim.js         # In-browser driver injected into the Playwright page;
    │   │                   #   runs the full receive flow and calls back into Node.
    │   └── README.md       # Usage doc
    │
    ├── server.js           # Express server: signaling API, ICE config, static serving,
    │                       #   serves vendored libs at /vendor/, /scribe/, /tessdata/.
    │                       #   Also exposes GET /send/:roomId as a pretty-URL redirect
    │                       #   for the sender flow. Startup banner prints the exact
    │                       #   STUN / TURN / TURNS URL list /api/config will hand out
    │                       #   (credentials masked) so missing TURNS_PORT is obvious
    ├── server-helpers.js   # Pure server-side helpers (origin parsing, rate-limit
    │                       #   sliding-window logic, TURN HMAC-SHA1 credential
    │                       #   derivation). Unit-tested
    ├── healthcheck.js      # Tiny HTTP health probe used by the Dockerfile HEALTHCHECK
    ├── package.json        # Runtime dep: express ^5. Dev deps: @playwright/test,
    │                       #   canvas, jsdom (used by unit / e2e tests only)
    ├── update-sri.js       # SRI hash generator for script/link integrity attributes:
    │                       #   recomputes SHA-384 for every js/* and css/* file and
    │                       #   patches the integrity="..." values in the HTML files
    ├── check-sri.js        # Verifier counterpart to update-sri.js: recomputes hashes
    │                       #   and fails CI / pre-push if any HTML integrity attribute
    │                       #   is stale
    ├── sri-hashes.json     # Generated SRI hashes (used by update-sri.js / check-sri.js)
    │
    └── public/             # Static frontend (vanilla HTML/CSS/JS, no build step)
        ├── index.html      # Landing page: "Receive" and "Send" buttons, About modal
        ├── receive.html    # Receiver flow: key generation, room creation, QR display,
        │                   #   WebRTC answer polling, decryption, image display,
        │                   #   perspective crop tool, Otsu B&W binarization,
        │                   #   PDF generation, export modal (ZIP/PDF/B&W/OCR)
        ├── send.html       # Sender flow: QR scanning (jsQR), room joining, key exchange,
        │                   #   camera capture or file picker, encryption, chunked sending
        ├── manifest.json   # PWA manifest (installable as app on mobile)
        ├── service-worker.js # PWA service worker: network-first with cache fallback
        │                   #   for static assets; API calls bypass the cache. Because
        │                   #   the network is always tried first, a fresh deploy is
        │                   #   picked up automatically without any cache-name bump
        │
        ├── css/
        │   └── style.css   # All styles: dark theme, large touch targets for accessibility,
        │                   #   responsive layout, crop modal, logs panel
        │
        ├── js/
        │   ├── collections.js # Receive page "collections" (one per sender batch,
        │   │               #   shown as a Document N section). Owns the collections
        │   │               #   array, activeCollectionId, and DOM rendering / drag-
        │   │               #   and-drop wiring. Cross-page state injected via
        │   │               #   Collections.attach({...}). Exposes window.Collections
        │   ├── crypto.js   # ECDH key exchange (P-256) + AES-GCM-256 encryption via
        │   │               #   Web Crypto API. Includes HKDF key derivation, key
        │   │               #   fingerprinting for MITM detection, size-bucket padding
        │   │               #   to hide exact file sizes, and metadata bundling (filename,
        │   │               #   MIME type encrypted inside the payload)
        │   ├── protocol.js # Data-channel message schemas, validation, and builders.
        │   │               #   Exposes window.Protocol.validate(msg) → {ok,error} and
        │   │               #   Protocol.build.* typed builder functions (one per wire
        │   │               #   message type). Every builder stamps protocolVersion:1.
        │   │               #   Includes bounded integer / size validation on file-start
        │   │               #   so a hostile peer cannot trigger huge allocations.
        │   │               #   Must be loaded before webrtc.js
        │   ├── webrtc.js   # WebRTC peer connection management: room creation/joining,
        │   │               #   SDP offer/answer exchange via server API, trickle ICE
        │   │               #   candidate relay, data channel setup, chunked file transfer,
        │   │               #   connection type detection (direct vs TURN relay).
        │   │               #   Receive state machine (file-start/binary/file-end/file-ack/
        │   │               #   file-nack assembly + anti-DoS bounds) is delegated to
        │   │               #   transport-assembler.js so WS, LP, and WebRTC share one
        │   │               #   implementation.
        │   │               #   Validates all inbound/outbound JSON messages via Protocol.
        │   │               #   Diagnostics: onicecandidateerror maps errorCode to a
        │   │               #   cause hint per STUN/TURN/TURNS server (401 = coturn auth,
        │   │               #   701 = DNS, >=700 = network/TLS); _logConnectionFailure
        │   │               #   splits STUN/TURN/TURNS counts, buckets local relay
        │   │               #   candidates by relayProtocol (udp/tcp/tls), and dumps
        │   │               #   every candidate-pair with reqSent/respRcvd/RTT.
        │   │               #   diagnoseIceServers({force:true}) runs per-server
        │   │               #   reachability probes even outside DEV mode on failure.
        │   ├── transport.js # RacingTransport: races WebRTC against the HTTP-relay
        │   │               #   transports under one duck-typed Transport surface
        │   │               #   (init/createRoom/joinRoom/sendMessage/sendFile +
        │   │               #   onConnected/onDisconnected/onMessage callbacks) so
        │   │               #   receive.html and sender-connect.js never branch on
        │   │               #   transport type. WebRTC is preferred via a
        │   │               #   RACE_GRACE_MS (10 s) window; the loser is closed when
        │   │               #   a winner locks in. Reconnect loop with cap-5 s backoff
        │   │               #   re-claims a fresh slot forever on a transient drop
        │   ├── transport-assembler.js # PayloadAssembler: shared receive-state
        │   │               #   machine (file-start / binary chunks / file-end /
        │   │               #   file-ack / file-nack) plus anti-DoS bounds
        │   │               #   (MAX_TOTAL_SESSION_BYTES, MAX_CONTROL_MSG_BYTES,
        │   │               #   MIN_FILE_START_SIZE). Operates on a host instance
        │   │               #   (the transport itself) so WebRTC, WS, and LP share
        │   │               #   one implementation instead of three copies that can
        │   │               #   drift. Exposes window.PayloadAssembler
        │   ├── ws-transport.js # HTTP-relay fallback transport over WebSocket
        │   │               #   (/api/rooms/:id/relay). Distinguishes transient close
        │   │               #   (onTransientDisconnect) from explicit teardown so the
        │   │               #   RacingTransport can reconnect mid-transfer without
        │   │               #   re-doing the ECDH handshake. relay-hello handshake
        │   │               #   on top of the wire gates onConnected on both peers
        │   │               #   actually joining the slot. Receive state via
        │   │               #   PayloadAssembler. Payloads remain end-to-end
        │   │               #   encrypted; the relay forwards opaque bytes only
        │   ├── lp-transport.js # HTTP-relay fallback transport over pure HTTPS
        │   │               #   POST/GET (/relay/handshake, /relay/up, /relay/down,
        │   │               #   /relay/close) for corporate proxies that strip WS.
        │   │               #   Wire format identical to ws-transport.js. The
        │   │               #   per-slot token returned by /handshake authenticates
        │   │               #   subsequent up/down calls in addition to the room
        │   │               #   secret. Same DoS bounds and PayloadAssembler reuse
        │   ├── logger.js   # In-memory log buffer with UI panel (slide-up overlay).
        │   │               #   Supports info/success/warn/error/debug levels.
        │   │               #   DEV mode (toggled via server config) enables verbose output
        │   ├── i18n.js     # Internationalization: English + French. Detects browser locale,
        │   │               #   applies translations via data-i18n attributes on DOM elements
        │   ├── crop-modal.js # Shared perspective-crop modal (injects its own DOM).
        │   │               #   Exposes window.CropModal.open({ sourceBlob, initialCorners,
        │   │               #   detectCorners, onApply, onCancel }); used by both send.html
        │   │               #   and receive.html so the ~450 LOC crop logic is not duplicated
        │   ├── doc-detect.js # Pure-JS document edge detection: downscale → grayscale
        │   │               #   → blur → Sobel → Otsu → contour trace, then per contour
        │   │               #   generates 3 candidate quads in parallel (Douglas-Peucker
        │   │               #   on the raw contour, DP on the convex hull, min-area
        │   │               #   rotated rectangle via rotating calipers) and scores
        │   │               #   each quad by **perimeter edge alignment** against the
        │   │               #   Sobel edge map (not brightness/area), so curved sides
        │   │               #   and folded corners still produce a usable crop. Corners
        │   │               #   are emitted in a consistent CW order (TL→TR→BR→BL) and
        │   │               #   segmentation is hardened against degenerate contours.
        │   │               #   Used by sender camera live overlay and the crop modal's
        │   │               #   auto-corner-detection. Exposes DocDetect
        │   ├── image-transforms.js # Shared image-transform utilities (applyOtsu,
        │   │               #   perspectiveTransform, distance, rotateImage, flipImage,
        │   │               #   binarize, cropPerspective). All transform results go through
        │   │               #   a central toBlob() normalizer. Used by sender gallery edits
        │   │               #   and receiver transform-replay. Exposes window.ImageTransforms
        │   ├── ocr-rescale.js # Pure helper: rescales scribe-OCR coordinates from the
        │   │               #   downscaled OCR-input dims back to the original image dims.
        │   │               #   Used by both the cached-assembly path and the on-demand
        │   │               #   fallback in receive.html (single source of truth)
        │   ├── pdf-builder.js # Hand-rolled minimal PDF 1.4 builder. Exposes
        │   │               #   window.PdfBuilder.buildPdf(images) — one page per JPEG,
        │   │               #   page sized exactly to the image. Extracted from receive.html
        │   │               #   so the byte-level xref/trailer logic can be unit-tested
        │   ├── scribe-handle.js # ScribeHandle class: owns one scribe.js instance and
        │   │               #   exposes init/import/recognize/export plus reset()/dispose()
        │   │               #   that hide the clear-vs-terminate API fork. Receive.html
        │   │               #   uses it for preloaded, background-queue, and per-export
        │   │               #   scribe lifecycles
        │   ├── receive-flow.js # Decrypt-and-display pipeline for incoming
        │   │               #   encrypted-file messages: decryptIncomingFile →
        │   │               #   addNewReceivedImage / applyImageReplacement, plus
        │   │               #   the handleEncryptedFile entry-point used by the
        │   │               #   receive.html messageHandlers map. Cross-page state
        │   │               #   (sharedKey, receivedImages, pendingReplaceHash, …)
        │   │               #   passed via ReceiveFlow.attach({...}). Exposes
        │   │               #   window.ReceiveFlow
        │   ├── receive-export.js # Export pipeline for the receive page: ZIP,
        │   │               #   plain PDF (via pdf-builder.js), OCR PDF (scribe.js
        │   │               #   with cached/fallback paths), and the per-card
        │   │               #   PDF→images / PDF→OCR actions (MuPDF). Owns the
        │   │               #   export modal wiring and the preloaded client-zip
        │   │               #   and scribe handles; bridges scribePreloaded to
        │   │               #   bg-ocr.js. Exposes window.ReceiveExport
        │   ├── bg-ocr.js   # Background OCR queue for the receive page. Walks
        │   │               #   receivedImages one at a time, downscales to <=2000px,
        │   │               #   runs scribe.js OCR, caches the page data on the image
        │   │               #   for later cached-assembly into a searchable PDF. Renders
        │   │               #   the OCR ⏳ / OCR… / OCR ✓ status badge on each card.
        │   │               #   Each queued image gets img.pendingOcr awaited by exporters.
        │   │               #   Exposes window.BgOcr (queue/cancel/waitFor/refreshBadge/
        │   │               #   isQueued/isProcessing/takeScribeIfIdle/reset)
        │   ├── eruda-loader.js # Shared on-demand loader for the vendored eruda
        │   │               #   mobile devtools console. Defines window.loadEruda
        │   │               #   (used by sidebar.js's 5-tap gesture and the DEV-mode
        │   │               #   bootstrap in send/receive) and auto-loads eruda when
        │   │               #   the URL contains ?debug=1 OR a sticky localStorage flag
        │   │               #   ("eruda-persist") is set (persists across reloads once
        │   │               #   eruda has been opened; clear with ?debug=0).
        │   │               #   Loaded by index/send/receive
        │   ├── peer-ui.js  # Shared sidebar helpers (onConnectionTypeDetected,
        │   │               #   showVerifiedInSidebar; re-exports loadEruda from
        │   │               #   eruda-loader) used identically by send.html and
        │   │               #   receive.html. Exposes window.PeerUI
        │   ├── receive-card.js # Builds the per-file card DOM (image / pdf / other)
        │   │               #   shown in the receiver's gallery. Pure DOM construction
        │   │               #   via createElement + textContent so peer-controlled
        │   │               #   filenames cannot execute. Exposes
        │   │               #   window.ReceiveCard.renderCard(opts) → HTMLElement.
        │   │               #   Caller (receive.html#addReceivedFile) owns parent
        │   │               #   lookup, appendChild, drag-event setup
        │   ├── sender-connect.js # Sender connection lifecycle: WebRTC state callbacks,
        │   │               #   ECDH key exchange, fingerprint verification handshake,
        │   │               #   reconnect-after-disconnect, transform-nack retry, and
        │   │               #   the inbound message dispatcher. Owns rtc/keyPair/
        │   │               #   sharedKey. Exposes window.SenderConnect with getRtc/
        │   │               #   getSharedKey getters consumed by the other modules
        │   ├── sender-camera.js # Sender camera concerns: QR scanner, photo-capture
        │   │               #   camera, flash/torch + ImageCapture fallback, live
        │   │               #   document-corner detection overlay, pinch-to-zoom,
        │   │               #   per-frame capture. Exposes window.SenderCamera
        │   ├── qr-parse.js # Pure parsing helper for QR / pasted URLs on the
        │   │               #   sender's scan step (kept out of send.html so it can
        │   │               #   be unit-tested without WebRTC / camera deps).
        │   │               #   QrParse.parseSendInvite(data, currentOrigin) returns
        │   │               #   {ok,roomId,secret} or {ok:false,reason:...}.
        │   │               #   Foreign-origin URLs (a phishing QR pointing at
        │   │               #   attacker.example) are rejected; bare relative paths
        │   │               #   for manual entry still work; secret length is
        │   │               #   bounded so a crafted QR cannot smuggle CR/LF or
        │   │               #   oversized junk into the X-Room-Secret header
        │   ├── sender-send.js # Sender outgoing photo queue: enqueue, serial drain,
        │   │               #   encryption + transmit (sendOnePhoto), per-photo
        │   │               #   gallery status updates, sticky progress banner, and
        │   │               #   the optional batch-end signal. Exposes window.SenderSend
        │   ├── sidebar.js # Shared sidebar (kebab button, overlay, language selector,
        │   │               #   connection info, logs/about actions, DEV badge, app version)
        │   │               #   used by index/receive/send. Exposes buildSidebar(),
        │   │               #   initSidebar(), updateDevBadge() (also on window) so each
        │   │               #   page only wires once. updateDevBadge() accepts the full
        │   │               #   /api/config object and also fills the sidebar version line
        │   ├── transfer-stats.js # Pure helpers to format transfer progress (rate,
        │   │               #   percent, ETA) into "42%  1.2 MB/s  14s" labels. Used by
        │   │               #   both send.html and receive.html
        │   ├── transform-replay.js # Receiver-side handler for `transform-image`
        │   │               #   messages: looks up image by oldHash, replays the transform
        │   │               #   list against stored originalData via image-transforms.js,
        │   │               #   swaps the card blob URL, restarts BgOcr. Sends `transform-
        │   │               #   nack` on failure. State injected via attach(). Exposes
        │   │               #   window.TransformReplay
        │   ├── verification-modal.js # Shared blocking modal for ECDH fingerprint
        │   │               #   verification. Used by both send.html and receive.html;
        │   │               #   centralises the modal show/hide + keydown listener
        │   │               #   cleanup that was previously duplicated. Exposes
        │   │               #   window.VerificationModal
        │   ├── wake-lock.js # Shared Screen Wake Lock manager (acquire/release +
        │   │               #   re-acquisition after visibilitychange). Used by both
        │   │               #   send.html and receive.html to keep the screen on during
        │   │               #   active transfers. Exposes wakeLockMgr
        │   ├── sender-gallery.js # Genius-Scan-like gallery for the sender page.
        │   │               #   Owns galleryPhotos state, thumbnail grid, per-photo
        │   │               #   edit (rotate/flip/BW/crop), drag-and-drop reorder,
        │   │               #   and batch finalization. Cross-page state injected
        │   │               #   via Gallery.attach({...}). Exposes window.Gallery
        │   ├── qrcode.min.js # QR code generator library (vendored, used by receiver)
        │   └── jsqr.min.js # QR code scanner library (vendored, used by sender)
        │
        ├── vendor/             # Vendored third-party libraries (committed to repo)
        │   ├── client-zip.js   # ZIP generator (ESM, ~6KB, preloaded in background)
        │   ├── scribe.js-ocr/  # OCR engine (AGPL-3.0): scribe.js + Tesseract WASM,
        │   │                   #   fonts, and mupdf — preloaded in background
        │   ├── tessdata/       # Tesseract language models (eng + fra .traineddata),
        │   │                   #   served locally to avoid CDN dependency
        │   └── eruda/          # Mobile devtools console (loaded in DEV mode, via
        │                       #   5-tap on the DEV badge, or by appending ?debug=1
        │                       #   to any page URL — served locally, no CDN)
        │
        └── icons/
            ├── icon.svg     # Master vector icon (used as favicon and sidebar brand)
            ├── icon-192.png # PWA icon (192x192)
            └── icon-512.png # PWA icon (512x512)
```

## Data Flow

```
  Receiver (computer)                    Server                     Sender (phone)
  ─────────────────                    ────────                   ───────────────
  1. Generate ECDH key pair
  2. POST /api/rooms ───────────────▶ Create room ◀─────────────── (scans QR later)
     ◀── roomId + secret ───────────
  3. Create WebRTC offer
  4. POST /api/rooms/:id/offer ─────▶ Store SDP offer
  5. Display QR code
     (URL with roomId + secret in
      hash fragment)
                                                                  6. Scan QR code
                                                                  7. GET /api/rooms/:id/offer
                                                                     ◀── SDP offer ──────────
                                                                  8. Create WebRTC answer
                                                                  9. POST /api/rooms/:id/answer
  10. GET /api/rooms/:id/answer ────▶ Relay SDP answer ──────────
      (long-polling)
      ◀── SDP answer ──────────────
                                      ICE candidates also relayed
                                      via /api/rooms/:id/ice/*

  ════════════ WebRTC P2P data channel established ════════════

  11. Send ECDH public key ─────────────────────────────────────▶ 12. Derive shared AES key
  ◀────────────────────────────────────────────── Send ECDH public key back
  13. Derive same shared AES key
  14. Show fingerprint verification modal ◀─────────────────────▶ Show fingerprint modal
  15. Both confirm match

  ◀──────────────────────────────────── Encrypt photo (AES-GCM, padded)
                                        Send via data channel chunks
  16. Decrypt, display, offer download
      Compute SHA-256 of decrypted data
      Send file-ack {sha256} ─────────────────────────────────────────▶
                                                                       17. Compare SHA-256 hashes
                                                                           Match → "Verified!", clear photo
                                                                           Mismatch → error, offer retry
```

### Image Edit Protocol (Transform Replay)

When the sender edits an already-sent image (rotate, flip, crop, B&W), instead of
re-encrypting and resending the full image, lightweight transform commands are sent:

```
Sender                                                        Receiver
──────                                                        ────────
Apply transform(s) locally
Send {type:'transform-image',                ──────────────▶  Find image by oldHash
      oldHash, transforms[]}                                  Replay transforms on stored originalData
                                                              Update image, restart OCR
```

Transform ops: `rotateCW`, `flipH`, `bw` (Otsu binarization), `crop` (with normalized
corner coordinates for perspective transform). The receiver stores `originalData` (the
as-first-received image) so transforms always replay from the pristine source.

The happy path is fire-and-forget (no positive ack). On failure (unknown `oldHash`,
missing `originalData`, or replay exception) the receiver sends `{type:'transform-nack',
oldHash, reason}`. The sender recovers by re-queueing the already-transformed bytes
through the existing `replace-image` / `encrypted-file` flow (`drainQueue` with
`replaceHash`), and resets the photo's local `transforms` array since the receiver's
new `originalData` baseline is the post-transform image. If the sender no longer has
the matching photo, it surfaces an error toast and gives up.

## Server API Endpoints

| Method | Path                         | Purpose                              | Auth        | Rate Limit      |
|--------|------------------------------|--------------------------------------|-------------|-----------------|
| GET    | `/send/:roomId`              | Pretty-URL redirect into the sender flow | None    | None            |
| GET    | `/api/config`                | ICE server list + DEV flag + OCR / file-type config | None | None     |
| POST   | `/api/rooms`                 | Create a room (returns ID + secret)  | None        | 5/min per IP    |
| GET    | `/api/rooms/:id`             | Check room existence                 | Room secret | 30/min per IP   |
| POST   | `/api/rooms/:id/offer`       | Store SDP offer                      | Room secret | 100/min per IP  |
| GET    | `/api/rooms/:id/offer`       | Retrieve SDP offer                   | Room secret | 30/min per IP   |
| POST   | `/api/rooms/:id/answer`      | Store SDP answer                     | Room secret | 100/min per IP  |
| GET    | `/api/rooms/:id/answer`      | Retrieve SDP answer (long-poll)      | Room secret | None            |
| POST   | `/api/rooms/:id/ice/offer`   | Add receiver ICE candidate           | Room secret | 100/min per IP  |
| GET    | `/api/rooms/:id/ice/offer`   | Get receiver ICE candidates          | Room secret | None            |
| POST   | `/api/rooms/:id/ice/answer`  | Add sender ICE candidate             | Room secret | 100/min per IP  |
| GET    | `/api/rooms/:id/ice/answer`  | Get sender ICE candidates            | Room secret | None            |
| WS     | `/api/rooms/:id/relay`       | HTTP-relay fallback (WebSocket; returns 404 when `RELAY_ENABLE=false` or `RELAY_LP_ONLY=true`) | `?secret=...` query | 100/min per IP |
| POST   | `/api/rooms/:id/relay/handshake` | Claim a long-poll relay slot     | Room secret | 100/min per IP |
| POST   | `/api/rooms/:id/relay/up`    | Push a frame on the long-poll relay  | Room secret + `X-Slot-Token` | 100/min per IP |
| GET    | `/api/rooms/:id/relay/down`  | Long-poll the next frame on this slot | Room secret + `X-Slot-Token` | 100/min per IP |
| POST   | `/api/rooms/:id/relay/close` | Clean teardown of a long-poll slot   | Room secret + `X-Slot-Token` | 100/min per IP |

All `/api/*` endpoints validate the `Origin` header against `ALLOWED_ORIGINS`.
Room endpoints require an `X-Room-Secret` header (constant-time comparison).
The HTTP-relay endpoints additionally require a per-slot token issued by
`/relay/handshake` so the room secret alone cannot be used to hijack a live
relay slot.

## Threat Model

The 36 numbered entries in [Security Layers](#security-layers) below are individual mitigations. This section names the adversaries those mitigations exist to defeat, the attacks that are explicitly in scope, the attacks that are explicitly out of scope (with rationale), and the trust assumptions the design rests on. Each in-scope item cross-references the numbered Security Layers entry (or entries) that addresses it, so a reviewer can trace any claim in this section to the code that backs it.

### Adversaries considered

1. **Passive network eavesdropper** on any link the traffic crosses: local Wi-Fi, ISP, signaling, TURN/TURNS relay.
2. **Active signaling-channel MITM**, including a fully malicious WebSend server operator, a compromised reverse proxy in front of the server, or any on-path attacker between the two peers and the signaling endpoint. The same model covers a malicious WebSocket / long-poll relay on the HTTP-fallback transport.
3. **Compromised or curious TURN / TURNS relay operator**, including a relay that logs all bytes.
4. **Hostile peer before fingerprint verification**: a stranger who learns the room ID and secret (e.g. shoulder-surfing the QR), joins the room, and pushes malformed wire messages, oversized chunks, or invalid transforms before the user has confirmed the fingerprint.
5. **Hostile peer after fingerprint verification**: a phone whose user was socially engineered into pairing, or a peer whose verification was accepted by mistake. Once verified, this peer can send real files, but it can still try to deliver oversized payloads, malicious filenames / MIME types, malformed transforms, or pathological PDFs.
6. **Compromised content delivery**: a tampered WebSend server, a hostile CDN, or any other path that could swap in modified JavaScript or CSS at load time.
7. **Phishing QR codes**: an attacker prints or shares a QR that encodes a URL on an attacker-controlled origin, hoping the user scans it from the legitimate WebSend page.
8. **Hostile script reaching the page** (e.g. an XSS escape, a malicious browser extension, or a future tampered third-party load) that tries to monkey-patch security-critical globals.

### In scope (defended)

- **Confidentiality and integrity of every file payload, end-to-end, even with hostile server and hostile relay.** ECDH P-256 + HKDF + AES-256-GCM, fresh ephemeral keys per session (forward secrecy). The server only ever sees ciphertext. (Layers §1, §2)
- **Detection of signaling-channel MITM.** A 64-bit SHA-256 fingerprint of each public key is read aloud by both users. A signaling MITM would need to grind ECDH keys to a chosen fingerprint, which is a second-preimage search whose cost is independent of how many rooms are live. (Layers §4, §23, §24)
- **Room enumeration and unauthorized room access.** A 128-bit room secret in the URL hash fragment is required for every room API call and compared in constant time. (Layers §3)
- **Resource-exhaustion DoS from a peer before verification** (the verification modal is up, but message handlers are already running). Caps on receive buffer, per-file size, per-session bytes, control-message size, and log-panel growth all fire before mutual confirmation. (Layers §16, §19, §27)
- **Resource-exhaustion DoS from a peer after verification.** Transform-replay caps, octet-stream blob URLs, PDF page-render cap, image-transform pixel cap, sender transform-nack retry cap, and background-OCR pixel cap all bound a verified-but-hostile peer. (Layers §17, §20, §28, §29, §30, §31)
- **Resource exhaustion against the server.** Per-IP rate limits, long-poll waiter caps (per-room and process-wide), and bounded relay-slot queues. (Layers §11, §18, §36)
- **Cross-origin and CSRF-style abuse.** Origin header validation on all `/api/*` endpoints; `X-Forwarded-For` only trusted from loopback. (Layers §12, §13)
- **XSS via peer-controlled filenames or MIME types.** All receiver-facing `blob:` URLs are forced to `application/octet-stream`, the per-file card uses `createElement` + `textContent` only, and a defensive Content-Security-Policy plus other hardening headers constrain even an inline-script escape. (Layers §20, §21)
- **Silent tampering of static assets.** Vanilla HTML/CSS/JS with no bundler or CDN, all third-party libraries vendored, Subresource Integrity on every script and link tag, plus a service worker that only caches same-origin `basic`-type responses. (Layers §9, §10, §25)
- **Cross-session data leakage on re-pair.** Both devices shred all in-memory user data (decrypted images, OCR text, preBW buffers, blob URLs, scribe WASM state, crypto keys) before establishing a new session. (Layers §32)
- **Re-key attack on an already-verified session.** The sender refuses any further `public-key` messages once a shared key exists; the receiver allows re-key but forces re-verification synchronously before any await. (Layers §24, §23)
- **Phishing QR pointing at an attacker origin.** The sender's scan / paste path rejects any URL whose origin is not the current origin, with a user-facing toast. (Layers §26)
- **Long-poll abuse of the signaling API.** Three layered caps (per-IP rate limit, per-room waiters, process-wide waiters) and per-slot tokens on the HTTP-relay fallback. (Layers §18, §36)
- **Information leakage via error responses.** A custom 4-arg error middleware scrubs Express's default stack-trace body; a custom 404 handler refuses to echo the requested path. (Layers §34)
- **Monkey-patching of security-critical globals from a hostile script.** `Object.freeze` is applied at export time to `WebSendCrypto`, `Protocol` (and `Protocol.build`), `QrParse`, `SenderConnect`, `SenderSend`, `ReceiveCard`, and `VerificationModal`. (Layers §33)

### Out of scope (explicitly NOT defended)

- **A fully compromised endpoint device** (rooted phone, malware on the receiver computer, hostile browser, hostile browser extension). Rationale: any application-layer protection is bypassable by code running inside the same browser context as the page. WebSend assumes both endpoints are honest.
- **A user who skips the spoken fingerprint comparison**, or who confirms a mismatch by mistake. Rationale: the fingerprint ceremony *is* the MITM defense. There is no other check that can detect a chosen-key MITM if the user does not actually compare the codes.
- **Targeted denial-of-service at the network / IP layer.** Rationale: WebSend mitigates application-layer DoS (giant chunks, pipelined long-polls, malformed messages) at the Node and browser layers; mitigating packet floods is the job of the upstream reverse proxy / CDN / firewall.
- **Forensic recovery of decrypted bytes from device RAM after a transfer.** Rationale: we drop references on shred so the garbage collector can reclaim the pages, but JavaScript cannot zero memory deterministically and we do not run in a TEE.
- **Compromise of the user's HTTPS certificate authority.** Rationale: a forged certificate breaks the TLS layer underneath everything; the fingerprint ceremony still catches an active ECDH MITM on top of that, but confidentiality of the room ID and timing metadata is gone.
- **Side-channel attacks against the browser's Web Crypto implementation.** Rationale: Web Crypto is the trusted cryptographic primitive; reimplementing it in user-space would expose worse side channels, not better ones.
- **Vulnerabilities inside coturn or oauth2-proxy themselves.** Rationale: these are external components; WebSend's threat model assumes they are correct. `misc/check_turn.py` is provided as a manual probe.
- **Traffic analysis beyond fixed-bucket size padding.** Rationale: padding to power-of-2 buckets hides the *exact* file size, but an observer can still see that some transfer happened, roughly when, and within which bucket. Hiding the timing pattern would require constant-rate padding traffic, which is not implemented.
- **Targeted ECDH key-grinding for a chosen 64-bit fingerprint.** Rationale: the fingerprint length (64 bits) is at the recognized floor for verbal-comparison ceremonies and is fixed regardless of server load; a determined attacker willing to spend significant compute can in principle grind a colliding fingerprint, but the cost is significant and the fingerprint length is held constant for that reason. (See the explanatory paragraph at Layer §4.)

### Trust assumptions

- Both endpoint devices, their operating systems, and their browsers behave honestly. A compromised browser can defeat any in-page protection by definition.
- The user actually compares the 16-hex fingerprint aloud and aborts on any mismatch. The four-list structure of this threat model exists precisely to make that requirement visible.
- HTTPS is correctly terminated in front of the server (typically Caddy + Let's Encrypt) and the TLS stack is sound.
- The vendored third-party libraries were honest at the time they were vendored. Subresource Integrity (§10) re-verifies the bytes at runtime, so a later swap is detected; a backdoor present at vendoring time is not.
- `NODE_ENV` is not relied on for security posture: the custom error / 404 handlers (§34) make the server safe to deploy even when `NODE_ENV` is unset, which it is in the shipped Docker image.

## Security Layers

1. **End-to-end encryption**: ECDH P-256 key exchange + HKDF + AES-GCM-256. Server never
   sees keys or plaintext. Fresh ephemeral key pairs per session provide forward secrecy.
2. **Zero server trust**: The server is a signaling relay only — it never sees encryption
   keys, plaintext photos, or file metadata. Rooms are ephemeral (10-minute TTL, in-memory).
3. **Room secrets**: 16-byte random token required for any room access. Passed in URL hash
   fragment (never sent to server in HTTP requests). Constant-time comparison prevents
   timing attacks. Prevents room enumeration even if the short room ID is guessed.
4. **Fingerprint verification**: Both parties see a 16-hex-char (64-bit) SHA-256
   fingerprint of each other's public keys, grouped as `XXXX-XXXX-XXXX-XXXX`, and must
   manually confirm they match. The length is fixed: 64 bits is the recognised floor
   for verbal-comparison fingerprints (Signal uses 60 decimal digits, OTR uses 40 hex /
   160 bits). The relevant attack is a signaling-MITM grinding ECDH keys to a chosen
   fingerprint, which is a second-preimage search whose cost is independent of how
   many rooms are live, so the code length must NOT be adapted to active-room count.
   An earlier "adaptive" version (3-12 hex) was removed for this reason: at 3 hex
   chars the search is feasible in sub-second time on a laptop.
5. **Size obfuscation**: Photos are padded to power-of-2 bucket sizes before encryption,
   hiding exact file sizes from network observers. Padding uses random bytes to prevent
   compression-based attacks.
6. **Metadata encryption**: Filename, MIME type, and original size are encrypted inside the
   payload, not sent in plaintext over the data channel.
7. **Transfer integrity verification**: After decryption, the receiver computes SHA-256 of the
   plaintext data and sends it back via `file-ack`. The sender compares it against its own
   pre-encryption hash to confirm end-to-end integrity. On mismatch or timeout, the sender
   can retry without losing the photo.
8. **No phone storage**: Photos are captured directly in the browser and stay in memory only —
   never written to the phone's gallery, filesystem, or local storage. Photos are kept in
   memory until the receiver confirms successful receipt.
9. **Supply chain attack resistance**: No frameworks, bundlers, or build tools — the frontend
   is vanilla HTML/CSS/JS with zero `node_modules` in the browser. All third-party
   client-side libraries (jsQR, qrcode.js, client-zip, scribe.js-ocr, Tesseract WASM +
   language models, eruda) are vendored directly in the repository — no CDN fetches at runtime.
   The server-side dependency footprint is minimal (Express.js plus `ws`
   for the HTTP-relay fallback transport added in v3.7.0; `ws` is the
   canonical Node WebSocket library, zero transitive deps, ~200 KB).
10. **SRI**: All `<script>` and `<link>` tags use `integrity` attributes (Subresource
   Integrity), ensuring even a compromised server cannot silently swap in tampered files.
11. **Rate limiting**: Per-IP sliding window limits on room creation (5/min), room lookup
    (30/min), and general API (100/min).
12. **Origin validation**: API rejects requests from unauthorized origins (CSRF protection).
13. **Proxy trust**: Express trusts `X-Forwarded-For` only from loopback (Caddy).
14. **Docker hardening**: Read-only filesystem, no-new-privileges, all capabilities dropped,
    non-root user, memory/CPU limits.
15. **TURN relay security**: Time-based HMAC-SHA1 credentials with configurable TTL. Even
    when relayed through TURN, photos remain end-to-end encrypted — the TURN server only
    sees encrypted blobs.
16. **Receiver-side payload bounding (anti-DoS)**: The data-channel binary branch refuses
    chunks that arrive before a valid `file-start`, refuses any chunk that would push the
    in-flight file past its declared `expectedSize`, and refuses any chunk that would
    push the cumulative session bytes past `Protocol.MAX_TOTAL_SESSION_BYTES` (4 GiB).
    On any of those, the data channel and peer connection are torn down immediately and
    the application is notified via `onDisconnected`. `Protocol.MIN_FILE_START_SIZE`
    (16 KiB, the smallest legitimate padded ciphertext) tightens the file-start size
    validator so a hostile peer cannot smuggle a tiny declared size to keep the buffer
    growing under the radar. These caps fire before fingerprint verification, so a
    not-yet-verified peer cannot OOM the receiver tab while the verification modal is up.
    The CLI shim (`src/cli/shim.js`) mirrors the same three bound checks plus a
    verified-fingerprint gate on `file-start`/`file-end`/`batch-end` and binary chunks,
    so the optional Node CLI receiver path enjoys the same protection as the browser path.
17. **Transform-replay hardening (anti-DoS)**: `Protocol.isTransformArray` caps
    `transforms[]` length at `MAX_TRANSFORMS_PER_MSG` (32) and, for `op:'crop'`,
    requires `corners` to be `{tl,tr,br,bl}` with each `{x,y}` being a finite number
    in `[0, 1]`. `cropPerspective` defensively clamps its output dimensions to
    `min(srcDim * 2, CROP_MAX_DIM=8192)` so even a validator bypass cannot drive a
    multi-GiB `createImageData` allocation or freeze the main thread on the inverse
    mapping loop. Peer-mutating handlers in `receive.html` (`encrypted-file`,
    `transform-image`, `replace-image`, `delete-image`, `batch-*`) are gated behind
    `weConfirmed && theyConfirmed` so an unverified peer cannot push files, replay
    transforms, or rearrange the gallery while the verification modal is still up.
18. **Long-poll waiter caps (anti-DoS)**: `GET /api/rooms/:id/answer?wait=true`
    is layered behind three independent caps so a peer holding a valid room
    secret cannot exhaust server memory or file descriptors by pipelining
    `?wait=true` requests over HTTP/2: (a) `rateLimitMiddleware('general')`
    caps per-IP request rate at 100/min, the same policy already applied to
    every other room-scoped endpoint; (b) `MAX_WAITERS_PER_ROOM = 4` rejects
    excess concurrent long-polls per room with 429 before allocating any
    socket / closure / timer; (c) a process-wide `MAX_TOTAL_WAITERS = 10000`
    counter caps total in-flight waiters across all rooms with 503. Each
    settle path (timeout, send, roomGone, client-abort) decrements the
    counter so it stays consistent across normal and TTL-expiry paths.
19. **Receiver UI DoS hardening (anti-DoS)**: Two independent caps prevent a
    verified-but-hostile peer (or any pre-verification flooder) from growing
    receiver-side DOM/state without bound. (a) `Collections.createNew()`
    refuses past `MAX_COLLECTIONS_PER_SESSION = 64`, so flooding `batch-start`
    cannot allocate unbounded collection sections. The cap resets on
    `Collections.reset()` (cross-session shred). (b) `logger.js` no longer
    appends DOM nodes to `#logs-panel` while it is hidden, and when visible
    trims `panel.children` to `logger.maxLogs = 500`; on next open
    `renderLogs()` rebuilds from the bounded in-memory buffer. This blocks
    the pre-verification log-flood OOM where each invalid wire message
    triggered `logger.warn`/`error` and grew the panel forever.
20. **Octet-stream blob URLs (anti-XSS)**: Every `blob:` URL the receiver
    hands to an `<img>`, the download `<a>`, the lightbox, or the crop
    modal is allocated with `application/octet-stream`, regardless of the
    peer-supplied `metadata.mimeType`. Without this, a verified peer could
    deliver a file with `mimeType: 'text/html'` (or `image/svg+xml`) and a
    user middle-click / right-click "Open in New Tab" on the download
    link or thumbnail would bypass the `download` attribute and navigate
    to the `blob:` URL — which inherits the document's origin — letting
    the peer execute JavaScript in the receiver origin and exfiltrate the
    room secret, other received files, or the WebRTC peer. Forcing
    octet-stream tells the browser to download instead of render. `<img>`
    tags content-sniff so thumbnails still display. The single source of
    truth is `ReceiveCard.makeSafeBlobUrl()` (`js/receive-card.js`); all
    receiver paths (decrypted files, transform replay, in-place rotate /
    B&W / crop) flow through it.
21. **Defensive HTTP headers**: Every response carries a baseline header
    set so a future code mistake (or compromised third-party asset) is
    constrained by the browser even if it slips past application-level
    checks: a Content-Security-Policy with `default-src 'self'`,
    `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'`,
    `base-uri 'self'` and a `connect-src 'self'` confined to our own
    origin; `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`;
    `Referrer-Policy: no-referrer` (defends the room secret in the URL
    hash); `Cross-Origin-Opener-Policy: same-origin` and
    `Cross-Origin-Resource-Policy: same-origin` to isolate our window
    from cross-origin openers and embedders; and a `Permissions-Policy`
    that disables the FLoC / Topics tracking surfaces. Inline
    `<script>`/`<style>` in the HTML are still allowed via
    `'unsafe-inline'` because the page logic is currently inline; moving
    that out is a follow-up that lets us drop the exception.
22. **Signaling-API hardening**: every `/api/*` response carries
    `Cache-Control: no-store` so a misbehaving CDN or browser cache
    cannot replay another session's offer / TURN credentials / room
    state to a different user. Both ICE-poll endpoints
    (`GET /api/rooms/:id/ice/offer` and `.../ice/answer`) sit behind the
    same per-IP rate limiter as their POST counterparts so a peer
    cannot turn the room secret into an unbounded read amplifier. Room
    creation re-tries collisions at most `MAX_ROOM_ID_TRIES` (32) times
    before returning 503, capping the worst-case allocation cost so a
    pathological state (huge live-room set, broken RNG) cannot peg the
    event loop.
23. **Sender-side mutual-verification gate**: the sender refuses to
    advance into capture mode (or transmit any photo) until BOTH sides
    have actually confirmed the fingerprint. `handleReady` checks
    `sharedKey && weConfirmed && theyConfirmed` and ignores premature
    `ready` messages, so a hostile receiver cannot fast-forward the
    sender UI by sending `ready` without ever sending
    `fingerprint-confirmed`. `sender-send.sendOnePhoto` adds a second
    independent gate via `SenderConnect.isVerified()` so a future code
    path that reaches the queue without going through the fingerprint
    flow still cannot leak plaintext. The two gates mirror the
    receiver's `VERIFIED_GATED_HANDLERS`.
24. **Sender-side re-key block**: once a shared key has been derived,
    `handlePublicKey` refuses any further `public-key` messages from
    the receiver. Accepting one would silently rotate the encryption
    key to a peer-chosen value while `weConfirmed`/`theyConfirmed`
    remain `true` from the original handshake (the user would think
    they had verified the peer, but every subsequent photo would be
    encrypted to the attacker's key). The legitimate re-key path goes
    through `SenderConnect.reconnect()`, which clears `sharedKey`,
    `weConfirmed`, and `theyConfirmed` synchronously before the new
    handshake. The receiver side allows re-key but forces re-
    verification synchronously before any await; the sender side
    blocks outright because the sender never asks for a new key in
    the protocol.
25. **Service-worker scope hardening**: the SW intercepts ONLY same-
    origin GET requests, and only writes responses to the cache when
    `response.type === 'basic'` (200, same-origin, non-opaque). Cross-
    origin requests (e.g. an admin-configured Umami tracker) pass
    straight through to the browser without SW involvement so a future
    upstream compromise cannot persist a malicious response in every
    user's PWA cache. Browser-level SRI on `<script integrity>` still
    rejects any tampered cached body at execution time; the SW filter
    is the belt-and-braces layer that avoids storing it in the first
    place. The cache version was bumped (`websend-v1` → `websend-v2`)
    so the activate handler evicts any cross-origin junk that earlier
    SW versions may already have stored.
26. **QR foreign-origin refusal**: the sender's scan / paste path runs
    every input through `QrParse.parseSendInvite(data, currentOrigin)`
    in `js/qr-parse.js`. If the input parses as a URL whose origin is
    not `window.location.origin`, the join is refused with a clear
    user-facing toast (i18n key `send.invalidQR.foreignOrigin`). This
    blocks a phishing variant in which an attacker prints or social-
    engineers a QR encoding `https://attacker.example/send/ABC123#xxx`
    expecting the user to scan it on the legitimate WebSend page: the
    visible-URL signal is now enforced, not ornamental. Bare relative
    paths (manual entry) still work, and an oversized secret is
    rejected so a crafted QR cannot smuggle junk into the
    `X-Room-Secret` header. Note: this is a defense-in-depth layer on
    top of fingerprint verification, which remains the primary safeguard
    against ending up in a hostile peer's room.
27. **Data-channel control-message size cap**: `webrtc.js handleMessage`
    refuses any JSON string whose byte size exceeds
    `Protocol.MAX_CONTROL_MSG_BYTES` (16 KiB) BEFORE calling
    `JSON.parse`. The largest legitimate control message
    (sender-public-key carrying a base64 ECDH P-256 key) is a few
    hundred bytes; the cap is comfortable headroom while denying a
    hostile peer the ability to force a multi-MB allocation in
    `JSON.parse` by sending a giant string. UTF-16 byte size is
    approximated as `string.length * 2` so an attacker cannot use
    astral codepoints to balloon memory at half the apparent character
    cost. This is the control-plane analogue of the existing
    `MAX_TOTAL_SESSION_BYTES` cap on the binary path.
28. **PDF page-render cap**: `receive-export.renderPdfPages` refuses
    to render more than `MAX_PDF_RENDER_PAGES` (1000) pages from any
    peer-supplied PDF. The "Export as images" and "Export as OCR PDF"
    per-card actions feed `file.data` directly into MuPDF; a malicious
    PDF can declare millions of pages, and rendering each one at 150
    or 300 DPI to a PNG chains large allocations on the main thread
    until the tab OOMs. We free the MuPDF document and throw with a
    clear "PDF has N pages, refusing to render more than 1000" error
    that surfaces as a user-visible toast.
29. **Image-transform pixel cap**: `image-transforms._loadBitmap` now
    refuses any decoded `ImageBitmap` whose pixel count exceeds
    `MAX_TRANSFORM_PIXELS` (150 megapixels). Previously `rotateImage`,
    `flipImage` and `binarize` inherited the source bitmap's
    dimensions unconditionally, so a 1 GB peer-supplied JPEG at
    ~30000x30000 (900 MP) would attempt a ~3.6 GB `ImageData`
    allocation on the main thread and reliably OOM the receiver tab.
    The cap is well above any consumer or medium-format stills camera
    output, and the transform-replay path (peer mutates an already-sent
    photo) flows through `_loadBitmap` so it is also bounded. Crops
    were already capped via `CROP_MAX_DIM`; this closes the matching
    hole for the other three transforms.
30. **Sender transform-nack re-send cap**: a verified-but-hostile
    receiver could otherwise spam `transform-nack` for the same
    `oldHash` and drive the sender into an infinite re-encrypt /
    re-send loop (the plaintext SHA-256, and therefore `photo.sentHash`,
    doesn't change between attempts, so each nack matches the same
    gallery photo). The sender now stamps each photo with a
    `nackRetries` counter and refuses any nack past
    `MAX_NACK_RETRIES_PER_PHOTO` (2) with an error log and an
    unmistakable user toast. 2 is enough for a legitimate retry plus
    a one-off transient failure.
31. **Background-OCR input pixel cap**: `bg-ocr.downscaleForOcr` runs
    `createImageBitmap` on peer-supplied bytes and would otherwise
    drive a large `OffscreenCanvas` allocation on a 30000x30000
    image (which some browsers will still decode). It now refuses any
    bitmap whose pixel count exceeds
    `window.ImageTransforms.MAX_TRANSFORM_PIXELS` (150 MP) and skips
    the image with a warning log, so the background OCR queue is
    never blocked on a pathological allocation. Falls back to the
    same hard-coded 150 MP if `ImageTransforms` happens to be absent
    at load time.
32. **Cross-session data isolation**: A new pairing on either device shreds all in-memory
    user data, OCR text, preBW pixel buffers, blob URLs, scribe WASM state, and crypto
    keys before establishing the new session. On the **sender**, scanning a QR with a
    different roomId triggers a confirm prompt (when the gallery is non-empty) and then
    a local shred; the same-room reconnect path keeps the gallery intact so a phone can
    re-pair after a network blip without losing unsent photos. On the **receiver**, a
    sender disconnect keeps the same room/QR alive (so the same phone can re-scan and
    reconnect with data preserved), and a deliberate "Start new pairing" button rotates
    to a fresh room and shreds everything. The signaling relay stores **only** ephemeral
    SDP + ICE in an in-memory `Map` with a 10-minute TTL and complete deletion on expiry —
    no database, no filesystem writes for room data, and no cross-room caching.
33. **Frozen security-critical globals**: `Object.freeze` is applied at
    export time to every namespace object that holds a cryptographic
    primitive, a protocol builder, the verification gate, or the safe
    blob-URL helper: `window.WebSendCrypto`, `window.Protocol` (and its
    nested `build` sub-object), `window.QrParse`, `window.SenderConnect`,
    `window.SenderSend`, `window.ReceiveCard`, and
    `window.VerificationModal`. Without this, a hostile script reaching
    the page (XSS via an inline-script CSP escape, a compromised browser
    extension, a future tampered third-party load) could monkey-patch
    `WebSendCrypto.deriveSharedKey` to return an attacker-known key,
    swap `Protocol.build.fingerprintConfirmed` to spoof verification,
    flip `SenderConnect.isVerified` to `() => true` to bypass the
    send-path gate, or rewrite `ReceiveCard.makeSafeBlobUrl` to emit
    `text/html` blob URLs and re-open the blob-XSS path that #20
    closes. Freezing the objects means any such write is a silent no-
    op (or a `TypeError` in strict mode) instead of a successful
    tampering. The non-security-bearing exports (`Collections`,
    `CropModal`, `Gallery`, etc.) are left mutable on purpose so
    tests / future refactors can stub them; the frozen set is exactly
    the surface where a swap would break the security model.
34. **Server error-handler scrubbing**: every Express response now
    flows through a final 4-arg error middleware and a final 404
    middleware before falling off the end of the chain. Express 4's
    stock error handler emits the full server stack trace in the
    response body whenever `NODE_ENV` is not exactly `"production"`,
    and the stock 404 handler echoes the requested path into a
    text/html "Cannot GET /x" page. WebSend does not set `NODE_ENV`
    anywhere (Docker image, CI, local dev all leave it unset), so
    without these handlers a thrown exception or a probe of an unknown
    URL would leak absolute source paths, the in-memory data shape,
    and Express / body-parser version fingerprints. The custom handler
    logs the real stack server-side, preserves well-formed 4xx status
    codes set by upstream middleware (e.g. body-parser's 413 for
    payloads over 50 kB, 400 for malformed JSON), but replaces
    `err.message` with a fixed phrase per status (`Payload too large`,
    `Bad request`, ...) so parser-fingerprint strings like "Unexpected
    token } in JSON at position 17" never reach the network. Any error
    outside `400..499` collapses to a generic 500 JSON. The 404
    handler returns `{"error":"Not found"}` and crucially does not echo
    the requested path, denying an attacker the ability to smuggle
    HTML or ANSI into log scrapers via the URL.
35. **Relay reconnect with byte-level resume**: When the WS or LP relay
    drops mid-transfer (proxy hiccup, network blip), the
    `RacingTransport` reconnect loop in `js/transport.js` re-claims a
    fresh slot forever with a cap-5 s backoff. `js/ws-transport.js` and
    `js/lp-transport.js` distinguish a transient close (new
    `onTransientDisconnect` callback) from an explicit teardown, and
    `js/transport-assembler.js` keeps the in-flight `receiveBuffer` /
    `expectedSize` / `receivedSize` intact across the drop. On
    reconnect, the receiver re-sends its public key (so the sender can
    verify the cached fingerprint hasn't changed) and, if a partial
    transfer exists, emits `file-resume-offer {size, received}`. The
    sender's `js/sender-send.js` caches the encrypted ciphertext on the
    queue head so the resume reuses the same GCM nonce (the receiver's
    partial buffer remains decryptable); it replies with
    `file-resume-ack {offset}` and continues binary chunks from that
    offset. A peer-fingerprint mismatch on reconnect is treated as a
    peer-swap and forces a fresh verification ceremony. WebRTC drops
    are still fatal in v1 (no ICE-restart resume yet); only the relay
    transports support resume.
36. **HTTP-relay fallback transport**: Corporate networks that block UDP
    and strip TURNS-over-TCP at the proxy used to leave WebSend with no
    working path. v3.7.0 adds an HTTPS-only fallback that runs over the
    same Caddy port 443 as the rest of the app. The client opens a
    WebSocket against `/api/rooms/:id/relay` in parallel with the WebRTC
    handshake; a 10-second race-grace window lets WebRTC win when it can
    (P2P / TURN / TURNS all still preferred), and the WS path wins
    afterwards when WebRTC has not connected. If the WS upgrade itself
    is refused or torn down, an on-demand long-poll transport
    (`/relay/handshake`, `/relay/up`, `/relay/down`, `/relay/close`)
    joins the race using pure HTTPS POST/GET so the path is
    indistinguishable from regular web traffic. The relay forwards
    opaque ciphertext between the two paired peers; the existing ECDH +
    AES-GCM + fingerprint stack is transport-agnostic, so the server
    never sees plaintext. Anti-DoS caps mirror the WebRTC bounds:
    `MAX_TOTAL_SESSION_BYTES` (4 GiB) and `MAX_CONTROL_MSG_BYTES`
    (16 KiB) enforced server-side, plus a bounded per-slot queue
    (32 frames) and idle timeout (60 s) on the long-poll path. The
    long-poll slot tokens are 128-bit randoms compared in constant time
    so the room secret alone cannot hijack a live slot. The sidebar
    surfaces the active path (Direct / Relay (TURN/TURNS) / Relay (HTTP/
    HTTPS)) and a one-time toast reminds the user that the relay is
    slower than P2P. Disabled by setting `RELAY_ENABLE=false` on the
    server, in which case the WS upgrade returns 404 and the long-poll
    endpoints return 404 too. Set `RELAY_LP_ONLY=true` (or the debug
    equivalent `DEV_FORCE_CONNECTION=RELAY_LP`) to disable WebRTC and
    WebSocket entirely so only the long-poll path is exercised; useful
    behind proxies that strip WS or for deployments standardising on a
    single transport. `/api/config` exposes an `lpOnly` flag so the
    client honours the same mode and skips both racers locally.

## SSO (Experimental)

WebSend can optionally be gated behind **Keycloak** SSO using **oauth2-proxy** as a
reverse authentication proxy. The architecture with SSO enabled:

```
Browser ──▶ Caddy (HTTPS) ──▶ oauth2-proxy (:4180) ──▶ websend (:8080)
                                    │
                                    ▼
                               Keycloak (OIDC)
```

- oauth2-proxy intercepts all HTTP/WS requests and redirects unauthenticated users
  to Keycloak's login page. After login, requests are proxied to the websend container.
- **WebSocket signaling** passes through oauth2-proxy (it supports WS upgrade).
  Once the WS tunnel is established it survives cookie expiry, because oauth2-proxy
  blindly forwards frames without re-checking the session. What does fail is the
  *next* upgrade attempt after a transient network blip: the new HTTP upgrade
  request needs a valid session cookie and will be redirected to Keycloak instead.
  The compose recipe sets `OAUTH2_PROXY_COOKIE_REFRESH=4m` to keep the cookie
  fresh below Keycloak's default 5-minute access-token lifetime so reconnects
  succeed silently.
- **coturn (TURN/STUN)** uses UDP/TCP protocols that oauth2-proxy cannot intercept.
  However, TURN credentials are minted by the `/api/config` endpoint, which sits
  behind oauth2-proxy, so unauthenticated clients never receive them.
- **Trust model**. The websend rate limiter keys on `req.ip`, which Express derives
  from `X-Forwarded-For` only when the immediate peer is in the `trust proxy` list.
  Default is `loopback` (Caddy on the same host). With SSO enabled, oauth2-proxy
  becomes the immediate peer at a Docker bridge IP, so `TRUST_PROXY=loopback,linklocal,uniquelocal`
  must be set on the websend service, otherwise every request appears to come from
  the auth proxy and the per-IP buckets degrade into one shared bucket.
- No user, group, or permission mapping is performed; it is a simple authentication gate.

This feature is experimental and was added with assistance from
[Claude Code](https://claude.ai/claude-code).

## Testing

Three tiers, layered from fast/cheap to slow/realistic:

- **Tier 1 — Unit** (`src/test/unit/`, run via `npm run test:unit`): pure-JS modules executed under the Node native test runner. Covers `crypto.js`, `image-transforms.js`, server helper functions, transfer stats, and `update-sri.js`. Browser modules are loaded via `test/support/load-browser-module.mjs` with a Web Crypto / canvas shim where needed. `doc-detect-samples.test.mjs` runs the document-edge detector against real camera shots in `test/fixtures/doc-samples/`, warps the detected quad to the ground-truth dimensions in `test/fixtures/doc-target-result/` via `ImageTransforms.perspectiveTransform`, and asserts both mean luminance and mean Sobel edge density of the crop match the target within 1% of 0..255 (BW + math, no colour classifier); skips automatically when the optional `canvas` devDep is not installed.
- **Tier 2 — HTTP integration** (`src/test/http/`, run via `npm run test:http`): each test file spawns the real `server.js` as a child process on a random port (see `test/http/helpers.mjs`) and hits it over the loopback network. Covers `/api/config` (and env-var propagation including `ALLOWED_FILE_TYPES` and Umami injection), origin validation, rate limiting, room/SDP/ICE signaling endpoints, long-poll fast-path / mid-wait delivery / client abort, body size limits, and the `/vendor` `/scribe` `/tessdata` static mounts. A `TEST_DISABLE_RATE_LIMIT=1` escape hatch lets test files that create many rooms bypass the per-IP limiter.
- **Tier 3 — End-to-end** (`src/test/e2e/`, run via `npm run test:e2e`): Playwright drives two real browsers (sender + receiver) through a full round-trip transfer.

A pre-push git hook at `.githooks/pre-push` runs `npm test` (Tier 1+2) and aborts the push on failure. The hook is auto-wired by the `prepare` script in `src/package.json` (sets `core.hooksPath=.githooks` on `npm install`).

**Not yet covered** (intentional gaps — documented so the picture is honest):
- Frontend modules with no unit tests: `webrtc.js` (peer-connection state machine, chunked transfer, connection-type detection), `logger.js`, `i18n.js` — tightly coupled to real `RTCPeerConnection` / DOM, so the E2E tier exercises them instead.
- Receiver UI logic: the perspective-crop tool and the **transform-replay protocol** (`transform-image` messages for `rotateCW` / `flipH` / `bw` / `crop`); the receiver-side replay handler lives in `js/transform-replay.js` (`window.TransformReplay`) and dispatches into `js/image-transforms.js`. The export modal (PDF / ZIP / B&W Otsu / scribe.js OCR / per-PDF actions) lives in `js/receive-export.js`; the hand-crafted minimal PDF generator lives in `js/pdf-builder.js` and has unit tests covering xref offsets, trailer size, and multi-image structure.
- Protocol edge paths: fingerprint **mismatch / abort**, `file-ack` integrity **mismatch or timeout → retry**, room TTL expiry (10 min), SRI-mismatch failure mode. E2E only drives the happy path.
- PWA service-worker caching + `controllerchange` auto-reload.
- `src/healthcheck.js` and SSO / oauth2-proxy endpoints. The `TRUST_PROXY` env-var parsing in `server.js` is also uncovered (default `loopback` is exercised by the HTTP tier, but non-default values are not).
- TURN time-based HMAC-SHA1 credential derivation (coturn itself is out of scope; `misc/check_turn.py` is the manual probe).

## Deployment

Expected to run behind **Caddy** reverse proxy which handles HTTPS termination.
Docker Compose exposes port 7395 mapped to internal 8080. Configure via `env` file
(copy from `docker/env.example`).

### TURNS data path

coturn ships with `--no-tls` and only listens on `3478/udp`, `3478/tcp`, and
the relay UDP range `49152-49161`. It does NOT have its own TLS listener and
does NOT need certificate files mounted in.

The public `turns:` URL advertised to clients (port from `TURNS_PORT`,
typically `443`) points at the **reverse proxy**, not at coturn directly. The
reverse proxy (Caddy with the [caddy-l4 plugin](https://github.com/mholt/caddy-l4))
matches `SNI=turn.<DOMAIN>` on its 443 listener, terminates TLS itself
(reusing the same TLS stack as regular HTTPS), and proxies the resulting
plaintext TURN stream to `coturn:3478/tcp`.

```
TURNS client ──TLS:443──▶ Caddy (caddy-l4, SNI=turn.<DOMAIN>) ──plaintext──▶ coturn:3478/tcp
                          │
                          └── same TLS stack as the regular HTTPS site,
                              so middleboxes cannot fingerprint coturn's
                              TLS server hello / ALPN and selectively
                              block TURNS while letting HTTPS through.
```

The reverse proxy owns the certificate; coturn is unaware that TLS is
involved at all. See README "TURN Relay Security" for the Caddyfile snippet.

### HTTP-relay fallback data path

For corporate networks that block UDP and strip TURNS at the proxy, v3.7.0
adds a pure-HTTPS fallback that runs through the same `:443` reverse-proxy
listener as the rest of the app. There is no separate container or port:
Caddy upgrades the WebSocket to the Node process and proxies HTTP
POST/GET for the long-poll endpoints, all on the existing signaling
surface.

```
                  ┌──── /api/rooms/:id/relay  (WS)  ──┐
client ──TLS:443──▶ Caddy ───────────────────────────▶ Node Express
                  └──── /api/rooms/:id/relay/*  (HTTP)┘
```

The client races three transports in parallel from the start:

1. **WebRTC**: P2P, then TURN, then TURNS. Always preferred.
2. **WebSocket** to `/api/rooms/:id/relay`: preferred over LP. A 10 s
   grace window lets WebRTC win when it can.
3. **Long-poll** over `/api/rooms/:id/relay/{handshake,up,down,close}`:
   spawned on demand if the WS path disconnects before either side wins.

A `relay-hello` handshake on top of the wire signals that both peers
have actually joined before the racer fires `onConnected`. The 4 GiB
session cap and 16 KiB control-message cap are mirrored server-side so
a malicious client cannot ignore the receiver-side bounds.

Disabled by setting `RELAY_ENABLE=false` on the server (the WS upgrade
and all `/relay/*` endpoints return 404, and `/api/config` reports
`relayEnabled:false` so the client never even tries).

Set `RELAY_LP_ONLY=true` (or `DEV_FORCE_CONNECTION=RELAY_LP`) to keep
the long-poll path enabled but turn off WebRTC and the WS relay. In
this mode `/api/config` returns an empty `iceServers` list and
`lpOnly:true`, the WS upgrade returns 404, and the client's
`RacingTransport` skips both the WebRTC and WS racers and spawns the
long-poll transport immediately at room setup. Useful behind proxies
that strip WS upgrades or for deployments standardising on one
transport. Requires `RELAY_ENABLE=true`; the server refuses to start
otherwise.

This feature was added with assistance from
[Claude Code](https://claude.ai/claude-code).
