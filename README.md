[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/thiswillbeyourgithub/WebSend)only

<p align="center">
  <img src="src/public/icons/icon.svg" alt="WebSend" width="128" height="128">
</p>

# WebSend

**Use your regular smartphone as a secure document scanner** -- even for sensitive documents.

**Try it now: [websend.olicorne.org](https://websend.olicorne.org/)**

## Table of Contents

- [Disclaimer](#disclaimer)
- [How It Works](#how-it-works)
- [Threat Model](#threat-model)
- [Security Features](#security-features)
  - [End-to-End Encryption](#end-to-end-encryption)
  - [Zero Server Trust](#zero-server-trust)
  - [Supply Chain Attack Resistance](#supply-chain-attack-resistance)
  - [Man-in-the-Middle Protection](#man-in-the-middle-protection)
  - [Room Security](#room-security)
  - [Rate Limiting and Origin Validation](#rate-limiting-and-origin-validation)
  - [Receiver Payload Bounding (Anti-DoS)](#receiver-payload-bounding-anti-dos)
  - [Transform-Replay Hardening (Anti-DoS)](#transform-replay-hardening-anti-dos)
  - [Receiver UI DoS Hardening (Anti-DoS)](#receiver-ui-dos-hardening-anti-dos)
  - [Chunked Authenticated Encryption (v2 wire format)](#chunked-authenticated-encryption-v2-wire-format)
  - [Transfer Verification](#transfer-verification)
  - [No Phone Storage](#no-phone-storage)
  - [Cross-Session Data Isolation](#cross-session-data-isolation)
  - [Docker Hardening](#docker-hardening)
  - [Subresource Integrity (SRI)](#subresource-integrity-sri)
  - [TURN Relay Security](#turn-relay-security)
- [Non-Security Features](#non-security-features)
- [Keycloak SSO (Experimental)](#keycloak-sso-experimental)
  - [Receiver-only authentication (Experimental)](#receiver-only-authentication-experimental)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Firewall (UFW)](#firewall-ufw)
- [Troubleshooting](#troubleshooting)
- [Tech Stack](#tech-stack)
- [Development](#development)
- [Third-Party Libraries](#third-party-libraries)
- [License](#license)

WebSend transfers photos directly between devices using WebRTC and end-to-end encryption. Photos are encrypted on the sender's device and decrypted only on the receiver's device. They never pass through any server unencrypted, and they never touch the phone's storage.

## Disclaimer

This project was developed with AI assistance ([Claude Code](https://claude.ai/claude-code)) with careful attention to security, but by someone without a formal background in computer science or security research.

## How It Works

1. **Receiver** (typically a computer) opens the app and clicks "Receive" -- generates encryption keys and displays a QR code
2. **Sender** (typically a smartphone) scans the QR code -- either by clicking "Send" and using the in-browser camera, or by scanning directly with any barcode scanner app (the URL opens the browser directly in sender mode)
3. A **direct peer-to-peer connection** is established via WebRTC
4. Both parties **verify key fingerprints** by reading short codes aloud to each other
5. **Sender** takes or selects photos, which are encrypted and sent directly
6. **Receiver** decrypts, previews, optionally crops/rotates/binarizes, and downloads the photos -- individually, as a ZIP, or as a single PDF (plain or searchable via OCR). Photos are auto-grouped into "collections" (one per sender batch). The sender side also exposes a Genius-Scan-like gallery (rotate, flip, B&W, perspective crop, drag-and-drop reorder) before the photos are sent, and auto-crops captured documents when edge detection is on

## Threat Model

The protections listed in [Security Features](#security-features) below address a specific set of adversaries and attacks. This section states that set explicitly so a reader can quickly tell what WebSend protects against and what it does not.

**Adversaries considered**:
- Passive network eavesdroppers on any link (local Wi-Fi, ISP, signaling traffic, TURN/TURNS relay traffic).
- Active man-in-the-middle on the signaling channel, including a fully malicious WebSend server operator, a compromised reverse proxy, or anyone between the two peers and the server.
- A compromised or curious TURN / TURNS relay operator.
- A hostile peer **before** fingerprint verification (a stranger who manages to join the room and floods malformed messages before the user confirms).
- A hostile peer **after** fingerprint verification (a phone whose user was socially engineered into pairing, then sends oversized files, malformed transforms, or peer-controlled filenames / MIME types).
- Compromised content delivery: a tampered WebSend server, a hostile CDN, or any attempt to swap in modified JS/CSS at runtime.
- Phishing QR codes that encode an attacker-controlled origin instead of the legitimate WebSend host.

**In scope (defended)**:
- Confidentiality and integrity of every file payload, end-to-end, even when the signaling server and the TURN relay are both hostile.
- Detection of a signaling-channel MITM through the spoken 16-hex-char fingerprint ceremony.
- Resource-exhaustion DoS attempts from a peer (both before and after the fingerprint ceremony) against the receiver tab, the sender tab, and the server process.
- Cross-origin and CSRF-style abuse of the signaling API.
- XSS via peer-controlled filenames or peer-declared MIME types.
- Silent tampering of static assets at the server or proxy (vendoring plus Subresource Integrity).
- Cross-session data leakage on either device when the user re-pairs (in-memory shred).
- Room enumeration or unauthorized room access by guessing the short room ID (room secret in URL fragment, never sent to server).

**Out of scope (explicitly NOT defended)**:
- A fully compromised endpoint device (rooted phone, malware on the receiver computer, hostile browser, hostile browser extension). Any application-layer protection is bypassable by code running inside the same browser context.
- A user who **skips** the spoken fingerprint comparison, or who confirms a mismatch by mistake. The verification ceremony is the security; bypassing it removes the guarantee against MITM.
- Targeted denial-of-service at the network / IP layer (we mitigate application-layer DoS, not packet floods).
- Forensic recovery of decrypted bytes from device RAM after a transfer (references are dropped on shred, but unreferenced pages are not zeroed).
- Compromise of the user's HTTPS certificate authority.
- Side-channel attacks against the browser's Web Crypto implementation.
- Vulnerabilities inside coturn or oauth2-proxy themselves.
- Traffic-analysis attacks beyond the built-in size obfuscation (random padding of the final segment and a fixed-size metadata record; an observer can still see that *some* transfer happened, roughly when, and its size to 256 KiB granularity).

**Trust assumptions**:
- Both endpoint devices, their operating systems, and their browsers behave honestly.
- The user actually compares the 16-hex fingerprint aloud and aborts on any mismatch.
- HTTPS is correctly terminated in front of the server (typically Caddy + Let's Encrypt) and the TLS stack is sound.
- The vendored third-party libraries were honest at the time they were vendored. Subresource Integrity re-verifies the bytes at runtime, so a later swap is detected, but a backdoor present at vendoring time is not.

## Security Features

### End-to-End Encryption
- **ECDH key exchange** (P-256 curve) with **AES-256-GCM** encryption via the Web Crypto API
- **Forward secrecy**: fresh ephemeral key pairs are generated for each session, so compromising a key later does not expose past sessions
- **HKDF key derivation** with domain separation to derive AES keys from the ECDH shared secret

### Zero Server Trust
- The server acts as a **signaling relay only** (exchanges SDP connection metadata between peers)
- The server **never sees encryption keys, plaintext photos, or file metadata**
- All photo data travels **peer-to-peer** via WebRTC data channels (or encrypted through TURN/TURNS if relaying is needed)
- Rooms and signaling data are **ephemeral** (stored in memory only; a signaling-only room dies 10 minutes after creation, a room carrying a relay transfer expires after 10 minutes of inactivity so long transfers are never cut off mid-flight)

### Supply Chain Attack Resistance
- **No frameworks, no bundlers, no build tools**: the entire frontend is vanilla HTML, CSS, and JavaScript -- there is no `node_modules` in the browser, no transpilation step, and no dependency tree that could be poisoned
- All third-party client-side libraries are vendored directly into the repository (not pulled from npm or a CDN at runtime) — see [Third-Party Libraries](#third-party-libraries) below
- **Subresource Integrity (SRI)** hashes on all local `<script>` and `<link>` tags ensure that even a compromised server cannot silently swap in tampered files
- The server-side dependency footprint is intentionally minimal (Express.js only)
- **Planned**: as it matures, WebSend intends to adopt [WEBCAT](https://github.com/freedomofpress/webcat/) (Web-based Code Assurance and Transparency, from the Freedom of the Press Foundation) for even stronger guarantees. WEBCAT adds enforced code signing and a transparency log on top of SRI, so that a compatible browser refuses to run a WebSend frontend whose signed manifest does not appear in the public log, closing the gap where a backdoor present at vendoring/build time would otherwise go undetected

### Man-in-the-Middle Protection
- **Key fingerprint verification**: after connection, both parties see a 16-hex-char (64-bit) SHA-256 fingerprint of each other's public keys, grouped as `XXXX-XXXX-XXXX-XXXX`, that they compare aloud to confirm no MITM key substitution occurred. The length is fixed at the recognised floor for verbal-comparison fingerprints (Signal uses 60 decimal digits, OTR 40 hex / 160 bits). It is deliberately NOT adapted to server load: a signaling-MITM grinds ECDH keys against any single session, so shortening the code under low load would not reduce attacker effort, just make the attack feasible in seconds on a laptop.
- Both parties must **explicitly confirm** the fingerprints match before photo transfer begins
- Either party can **abort** if fingerprints don't match

### Room Security
- Room IDs are short (6 characters) for usability, but each room also has a **128-bit cryptographic secret** (generated with `crypto.randomBytes`)
- The secret is embedded in the QR code URL's **hash fragment** (never sent to the server in HTTP requests)
- All room API calls require the secret via the `X-Room-Secret` header
- Secret comparison uses **constant-time comparison** (`crypto.timingSafeEqual`) to prevent timing attacks
- This prevents room enumeration and unauthorized room access even if an attacker guesses or brute-forces the short room ID

### Rate Limiting and Origin Validation
- **Per-IP rate limiting** on room creation (5/min), room lookups (30/min), and general API calls (100/min) to prevent DoS and enumeration. The general 100/min cap also covers `GET /api/rooms/:id/answer?wait=true` so a peer holding a valid secret cannot pipeline long-polls to exhaust memory. The HTTP-relay data path (`/relay/up`, `/relay/down`) is exempt: a single LP transfer is many POSTs and corporate NATs share one egress IP across many users, so a per-IP cap on the data path made multi-MB transfers impossible. The relay endpoints are still bounded by the per-frame body cap, the 8 GiB per-pairing session cap, the bounded peer queue (enforced as backpressure: `/relay/up` answers 429 when the peer's queue is full and a WS sender's socket is paused, so a slow receiver throttles the sender instead of losing frames), the slot idle timeout, and the per-slot token gating every call.
- **Origin header validation** blocks cross-origin API requests from unauthorized websites (CSRF-like protection)
- Express **trusts proxy headers only from loopback**, so `X-Forwarded-For` cannot be spoofed by external clients (designed to run behind [Caddy](https://caddyserver.com/))
- **Long-poll waiter caps**: layered defense for `?wait=true`. A per-room cap (4 concurrent waiters) refuses extras with 429, and a process-wide ceiling (10000 in-flight waiters) refuses extras with 503, before any socket / closure / timer is allocated.

### Transport Security Headers
- Every response carries a defensive header set (Content-Security-Policy, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP, Permissions-Policy).
- WebSend trusts the reverse proxy (Caddy) to terminate TLS, but adds belt-and-braces enforcement on top: on any connection the server sees as HTTPS (`req.secure`, derived from `X-Forwarded-Proto` and trusted only from the loopback proxy) it sends a **`Strict-Transport-Security`** header (`HSTS_MAX_AGE`, default 1 year; set `0` to disable) so a browser refuses plain HTTP for the origin after the first secure visit, and appends **`upgrade-insecure-requests`** to the CSP so a stray `http:` / `ws:` subresource is upgraded before it leaves the browser. Both are skipped on a plain-HTTP connection so local dev still works. This is the failsafe that keeps the sender/relay and relay/receiver hops encrypted at the transport layer (WebRTC is always DTLS, and the WS / long-poll relay paths use `wss:` / `https:`) underneath the end-to-end AES-GCM layer.
- The default `ALLOWED_ORIGINS` no longer accepts the cleartext `http://{DOMAIN}` origin unless `DOMAIN` is the local-dev sentinel `localhost`.

### Receiver Payload Bounding (Anti-DoS)
- The binary plane is a streaming record parser that buffers at most one partial record, hard-bounds every record's declared ciphertext length, refuses a record sequence number that skips ahead (framing desync), and refuses bytes that would push the cumulative session total past 8 GiB (one 4 GiB max-size file plus protocol overhead plus a fully retried tail). On any of those, the data channel and peer connection are torn down immediately.
- Decryption only happens after fingerprint verification; records from an unverified peer are parsed and dropped in constant memory, so a not-yet-verified peer cannot OOM the receiver tab while the verification modal is up.

### Transform-Replay Hardening (Anti-DoS)
- The `transform-image` validator caps `transforms[]` length (32 ops max) and, for `op:'crop'`, requires four `{tl, tr, br, bl}` corners with normalized `{x, y}` in `[0, 1]`. Peer-supplied corners outside that range are rejected before any pixel work happens.
- `cropPerspective` defensively clamps its output dimensions to `min(srcDim * 2, 8192)` so even a validator bypass cannot drive a multi-GiB `createImageData` allocation or freeze the main thread on the inverse-mapping loop.
- Peer-mutating handlers (`encrypted-file`, `transform-image`, `replace-image`, `delete-image`, `batch-*`) are gated behind both-sides fingerprint confirmation, so an unverified peer cannot push files, replay transforms, or rearrange the gallery while the verification modal is still up.

### Sender Picker Bounding (Anti-OOM)
- The send-page file picker (`#file-input` / `#dir-input`) refuses selections larger than 50 files in one go. EXIF stripping re-encodes every image to PNG, which inflates a typical phone photo from ~5 MB to ~30 MB; a "select all" against a full gallery would otherwise pile up hundreds of MB of stripped blobs before the first byte hit the wire and kill the renderer on Android Chrome.
- Selected files are processed and queued one-at-a-time (strip → push → drain in a loop), so peak resident memory is bounded by ~1 stripped blob in the queue plus 1 in flight regardless of selection size.

### Receiver UI DoS Hardening (Anti-DoS)
- `Collections.createNew()` refuses to allocate past 64 collections per session, so a verified-but-hostile peer flooding `batch-start` cannot grow receiver-side DOM/state without bound. The cap is reset on cross-session shred.
- The logs panel does not append DOM nodes while it is hidden, and when visible trims its children to `logger.maxLogs` (500). On next open it rebuilds from the bounded in-memory log buffer. A pre-verification flood of invalid wire messages (each producing a `logger.warn`/`error`) can no longer grow the panel forever and OOM the tab.

### Chunked Authenticated Encryption (v2 wire format)
- Since v4.6.0 every file travels as a stream of **independently authenticated AES-GCM records** (STREAM construction): a per-file key is derived via HKDF from the ECDH secret and a fresh random salt, each 256 KiB segment is sealed with a counter nonce plus a final-record flag, so **corruption, reordering, truncation, and replay are all detected at the exact segment where they happen** — no relay or network hop ever has to be trusted for integrity
- A bad or missing record triggers an automatic **segment-level retry** (`segment-nack` → the sender rewinds, re-keys with a fresh salt, and resends just the tail), so a flaky relay or spotty connection costs a few segments, not the whole file
- Both sides run in **near-constant memory** (the sender reads the file one segment at a time, the receiver accumulates verified segments as Blob parts), which raises the file cap to **4 GiB**
- File metadata (name, MIME type, original size) is **encrypted inside a fixed-size metadata record**, not sent in plaintext over the data channel; the final segment is padded with random bytes so observers learn the size only to 256 KiB granularity

### Transfer Verification
- Every record is verified as it arrives (AEAD authentication); after the last one, the receiver acks with a **composite SHA-256 hash** (a hash over the per-segment plaintext digests)
- The sender compares this against its own composite hash to **verify end-to-end identity** (encryption, transfer, and decryption all succeeded)
- If verification fails or times out, the sender is notified and can **retry** without losing the photo; transient failures are first retried automatically at segment granularity (see above) before anything is surfaced to the user
- A `file-end` with records missing is answered with the same segment-retry path, and only after the retry budget is exhausted does the receiver reject with a distinct "incomplete" error so both sides see "data lost in transit, retry" instead of an opaque checksum failure

### No Phone Storage
- Photos are captured directly in the browser (no camera app) and **stay in browser memory only**
- Photos are never written to the phone's gallery, filesystem, or local storage
- Photos are kept in memory until the receiver confirms successful receipt — only then are they cleared

### Cross-Session Data Isolation
- A **new pairing on either device shreds all in-memory user data** (decrypted images, OCR text, preBW pixel buffers, blob URLs, scribe WASM state, crypto keys) before establishing the new session
- **Sender**: scanning a QR with a different `roomId` triggers a confirm prompt (when the gallery is non-empty) and then a local shred. The same-room reconnect path keeps the gallery intact, so a phone can re-pair after a network blip without losing unsent photos
- **Sender**: files picked while the connection is down (e.g. the OS file picker backgrounded the page and the link dropped) are not refused: they queue locally, a toast explains they will go out after the reconnect, and the send loop flushes them automatically once the transport is back and the session re-verified (the loop checks both, so a file picked during a transient relay drop waits instead of being pushed into a closed socket and failed). A recovered connection also restores the send screen instead of stranding the user on the connecting step
- **Receiver**: a sender disconnect keeps the same room and QR alive (so the same phone can re-scan and reconnect with data preserved). A deliberate **"Start new pairing"** button in the disconnect banner rotates to a fresh room and shreds everything
- The signaling relay stores **only ephemeral SDP + ICE in an in-memory `Map`** with a 10-minute TTL and complete deletion on expiry — no database, no filesystem writes for room data, no cross-room caching

### Docker Hardening
- Runs as a **non-root user** (UID 1001)
- **Read-only root filesystem** in the container
- **All Linux capabilities dropped** (`cap_drop: ALL`)
- **No privilege escalation** (`no-new-privileges:true`)
- **Resource limits** (128 MB memory, 0.5 CPU) to prevent DoS
- Health check for monitoring

### Subresource Integrity (SRI)
- All local JavaScript and CSS files include **SRI integrity hashes** in their `<script>` and `<link>` tags, ensuring files have not been tampered with

### TURN Relay Security
- TURN credentials are **time-based** (HMAC-SHA1, standard coturn ephemeral credentials) and expire after a configurable TTL (default: 1 hour, see `TURN_CREDENTIAL_TTL`)
- Even when relayed through TURN, photos are still **end-to-end encrypted** -- the TURN server only sees encrypted blobs
- **TURNS (TURN-over-TLS)** is enabled by:
  1. Setting `TURNS_PORT=443` in `.env` (this is the public port the reverse proxy listens on, not coturn's port)
  2. Configuring your reverse proxy to terminate TLS for `turn.<DOMAIN>` on 443 and proxy the plaintext TURN stream to coturn's `3478/tcp` listener
  - coturn itself runs with `--no-tls` and does not need any certificate files (the reverse proxy owns the TLS material)
- **Why front coturn behind the reverse proxy** instead of letting coturn terminate TLS itself: coturn's TLS stack has a different JA3S fingerprint and ALPN behaviour from a regular HTTPS server, so middleboxes that allow your normal HTTPS traffic may still selectively drop a direct TURNS connection. Fronting coturn behind the same TLS stack as your HTTPS site makes TURNS traffic indistinguishable from regular HTTPS on the wire
- **Caddy example** (requires the [caddy-l4 plugin](https://github.com/mholt/caddy-l4), built with `xcaddy build --with github.com/mholt/caddy-l4`):
  ```caddy
  {
      servers {
          listener_wrappers {
              layer4 {
                  @turns tls sni turn.<DOMAIN>
                  route @turns {
                      tls {
                          connection_policy {
                              alpn h2 http/1.1
                          }
                      }
                      proxy localhost:3478
                  }
              }
              tls
          }
      }
  }
  ```

### HTTP-Relay Fallback (Corporate Networks)
- On networks that block UDP and strip TURNS at the proxy, WebSend now falls back to a pure-HTTPS path that runs through the same `:443` reverse-proxy listener as the rest of the app. No separate container or port; the same Caddy reverse proxy upgrades the WebSocket and handles the long-poll endpoints to the Node process.
- The client races three transports in parallel: WebRTC (preferred), WebSocket to `/api/rooms/:id/relay`, and an on-demand long-poll over `/api/rooms/:id/relay/{handshake,up,down,close}` (auto-spawned when the WS path is refused). A 10 s grace window lets WebRTC win when it can; afterwards the relay path wins.
- The relay forwards opaque ciphertext between two paired peers. The existing ECDH + AES-GCM + fingerprint stack is transport-agnostic, so the server never sees plaintext on this path either.
- Anti-DoS caps are mirrored server-side: 8 GiB `MAX_TOTAL_SESSION_BYTES`, 16 KiB `MAX_CONTROL_MSG_BYTES`, plus a 32-frame bounded queue and 60 s idle timeout on the long-poll slots. Long-poll slot tokens (128-bit random) are validated in constant time alongside the room secret.
- The long-poll transport uses 300 KiB chunks (vs. 16 KiB on the WebSocket / WebRTC paths) because every chunk is a full HTTPS round-trip, paced at a 50 ms minimum gap (~6 MB/s) so an unfriendly corporate proxy in front of the server cannot trip us with its own rate limit. `Retry-After` is honoured on 429 so a saturated upstream bucket drains instead of looping.
- Before sealing, each segment attempts `gzip` via `CompressionStream` and the compressed bytes are used only if they shrink the segment, flagged inside the sealed record. Highly compressible payloads (text, JSON, logs) shrink dramatically; already-compressed media (JPEG, PNG, MP4) fall through unchanged.
- Both relay variants report the peer's undrained backlog back to the sender (an `X-Peer-Backlog-Bytes` header on long-poll uploads, throttled `relay-backlog` frames on the WebSocket) so the sender's progress and rate display delivered bytes instead of running up to the server's 8 MiB peer buffer ahead of the receiver.
- The sidebar shows the active path: **Direct**, **Relay (TURN)**, **Relay (TURNS)**, **Relay (HTTP)**, or **Relay (HTTPS)**.
- Disable by setting `RELAY_ENABLE=false` on the server (default is `true`).
- **Long-poll-only mode**: set `RELAY_LP_ONLY=true` (or the debug equivalent `DEV_FORCE_CONNECTION=RELAY_LP`) to force the long-poll relay path only. WebRTC ICE servers are suppressed and the WebSocket relay endpoint returns 404, so the client uses only `/api/rooms/:id/relay/{handshake,up,down,close}`. Useful behind proxies that strip WS upgrades or for deployments standardising on a single, well-understood transport. Requires `RELAY_ENABLE=true`; the server aborts startup otherwise.
- **Reconnect with segment-level resume** (added with [Claude Code](https://claude.ai/claude-code)): a transient drop no longer kills the session on any transport. The `RacingTransport` retries forever with a cap-5 s backoff, the receiver keeps every already-verified segment across the drop, and the resume protocol (`file-resume-offer {nextSeq}` + `file-resume-ack {nextSeq, salt}`) lets the sender continue from the first record the receiver is missing, re-keyed with a fresh salt (a key/nonce pair is never reused). If the peer's public-key fingerprint matches the one verified at pairing time, the verification modal is not re-shown; a mismatch is treated as a possible peer-swap and forces re-verification.

## Non-Security Features

- **Large file transfers (up to 4 GiB)**: the chunked wire format streams files segment by segment in near-constant memory and survives connection drops with segment-level resume, so multi-GiB files work even on spotty connections. Files above 64 MiB are kept Blob-backed on the receiver and offered as a plain download (no preview, edits, or OCR, which would require pulling the whole file into memory). Note: iOS Safari has known multi-GiB Blob limits; for files in that range prefer a desktop receiver
- **PWA (Progressive Web App)**: installable on mobile home screens, with service worker for fast UI shell loading and an auto-reload on each deploy (the cache name is timestamped during SRI regeneration)
- **Internationalization (i18n)**: supports English and French, auto-detected from browser locale
- **Live document edge detection** on the sender camera: pure-JS pipeline (downscale → Sobel → Otsu → foreground masks cleaned by morphological opening + largest-connected-component → multi-candidate quad fitting scored by perimeter edge alignment and page-mask coverage) overlays a green outline of the detected page in real time, and pre-fills corner positions when entering the crop tool. The coverage term keeps an on-page shadow from collapsing a corner inward
- **Auto-crop on capture**: with detection on, a captured photo is run through the detector at full resolution and perspective-cropped automatically, so the gallery shows the cropped page and the receiver receives the smaller cropped image first. The full picture is kept locally as the crop source, so re-opening the crop tool shows the whole image and the crop can be undone or re-adjusted
- **Sender-side gallery (Genius-Scan-like)**: thumbnail grid with per-photo rotate / flip / B&W / perspective crop, drag-and-drop reorder, and batch finalization before sending
- **Transform replay**: when the sender edits an already-sent photo, only a small `transform-image` command is re-encrypted and re-sent rather than the full image; the receiver replays the transforms against its stored original (with a `transform-nack` fallback that triggers a full resend)
- **Receiver collections**: photos are auto-grouped per sender batch and shown as "Document N" sections, supporting drag-and-drop reorder and per-collection PDF/ZIP export
- **Document cropping**: perspective-corrected 4-corner crop tool, shared between sender and receiver via a single `crop-modal.js` module so the logic isn't duplicated. On both sides the handles auto-position on the detected document the first time an image is cropped, and restore the previous crop position on a re-crop; cropping is non-destructive (the handles can be dragged back out to undo)
- **Export modal**: download received images as PDF or ZIP, with optional B&W (Otsu thresholding) and **OCR** producing a searchable PDF (scribe.js + Tesseract WASM). OCR runs in a background queue as photos arrive (status badge per card), then assembles cached results at export time. OCR uses LSTM-only mode and downscales large images to 2000px for recognition to keep it usable in a browser, while preserving original image quality in the final PDF
- **Per-PDF actions**: when an incoming file is a PDF, dedicated buttons let you re-export it as a ZIP of page images or as a re-OCR'd searchable PDF (rendered with bundled MuPDF)
- **PDF export**: hand-crafted minimal PDF 1.4 generator, no dependencies (one page per JPEG, page sized to image)
- **ZIP export**: client-zip (preloaded in background)
- **B&W document mode**: Otsu's automatic binarization for crisp scanned documents
- **QR code scanning**: in-browser QR code scanning (jsQR) and generation (qrcode.js)
- **Connection type detection**: shows whether the connection is direct (local network or via STUN) or relayed (TURN/TURNS)
- **Debug logging**: "Logs" button on both sender and receiver pages for troubleshooting, with optional verbose DEV mode. A vendored [eruda](https://github.com/liriliri/eruda) mobile devtools console can be opened on demand by appending `?debug=1` to any page URL or by 5-tapping the DEV badge in the sidebar. Once opened it stays on across reloads (sticky `eruda-persist` flag in localStorage); append `?debug=0` once to turn the auto-load back off
- **Configurable file types**: `ALLOWED_FILE_TYPES` env var restricts uploads to images (`ONLY_IMAGES`), images + PDFs (`IMAGE_OR_PDF`), or anything (`ANY`, default)
- **Large button UI**: designed for usability by non-technical users
- **No heavy frameworks**: vanilla HTML5 + CSS + JavaScript only

## Keycloak SSO (Experimental)

WebSend can be placed behind [Keycloak](https://www.keycloak.org/) authentication using [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/). This provides a simple "authenticated or not" gate: only users who log in via Keycloak can access the app. No user, group, or permission mapping is performed.

The oauth2-proxy service is wired up in `docker-compose.yml` under the `auth` [compose profile](#compose-profiles). Setting `COMPOSE_PROFILES=auth` (or `auth,turn`) in your `.env` swaps in a websend variant that has **no published host port** and brings up oauth2-proxy in front of it on `127.0.0.1:4180`, all without editing the YAML. This feature was added with assistance from [Claude Code](https://claude.ai/claude-code).

**Required configuration when enabling SSO**:

- Register `https://${DOMAIN}/oauth2/callback` as a Valid Redirect URI in the Keycloak client, and `https://${DOMAIN}` as a Web Origin. The compose file already wires `OAUTH2_PROXY_REDIRECT_URL` to that exact URL.
- Set the `OAUTH2_*` variables in your `.env` (see `docker/env.example`).
- Point your reverse proxy at `127.0.0.1:4180` instead of `127.0.0.1:7395`. The `auth` profile's websend variant has no host port to expose, so there is no way to bypass the gate from the host.

`TRUST_PROXY` is set automatically to `loopback,linklocal,uniquelocal` by the `auth` profile; the override is needed because oauth2-proxy runs as a sibling container at a Docker bridge IP, and without it the per-IP rate limiter collapses every caller into one shared bucket and a single user can lock the rest out. Only override `TRUST_PROXY` yourself if you have extra proxy hops upstream of Caddy.

**Status**: Experimental. WebSocket signaling passes through oauth2-proxy and an established WS tunnel survives cookie expiry; what fails is the next upgrade attempt after a transient blip, because the new HTTP upgrade needs a valid session cookie. The compose block sets `OAUTH2_PROXY_COOKIE_REFRESH=4m` (slightly below Keycloak's default 5-minute access-token lifetime) so the cookie is rotated silently and reconnects keep working. coturn (TURN/TURNS/STUN) traffic is not protected by oauth2-proxy (it uses UDP/TCP, not HTTP), but is indirectly secured because TURN credentials are minted by `/api/config`, which sits behind oauth2-proxy, so unauthenticated clients never receive them.

### Receiver-only authentication (Experimental)

The SSO gate above (`AUTH_SCOPE=both`, the default) requires **every** peer to log in. `AUTH_SCOPE=receiver` requires login only for the **receiver** (the side that creates the room) and leaves the **sender** on a separate open host with no login. This fits the common case where the receiver is a staff member inside a corporate network that can do SSO, while the sender is an external person who cannot. Enable it with `COMPOSE_PROFILES=auth-split` (not `auth`).

```
RECEIVER ──▶ gated host (SSO) ──▶ oauth2-proxy :4180 ──▶ websend :8080
SENDER   ──▶ open host (no SSO) ─────────────────────▶ websend :7395
```

**Why "only staff may receive" holds.** Creating a room is what makes you a receiver, and `POST /api/rooms` is the only endpoint that mints one. In receiver mode the app **refuses room creation** unless the request carries the identity header oauth2-proxy injects after login (`AUTH_IDENTITY_HEADER`, default `x-auth-request-user`). So an unauthenticated sender cannot become a receiver. The actual file transfer (WebRTC/relay) is shared between the two peers and stays open, protected by the per-room 128-bit secret exactly as in the non-SSO `direct` profile, so a transfer is no less private than a `direct` deploy; only *who may start one as the receiver* is restricted.

**You MUST configure the reverse proxy, or the guarantee is void.** The app-side header check is defense in depth; the non-forgeable gate is the network path you control:

- Route the **receiver** (gated) hostname to `127.0.0.1:4180` (oauth2-proxy), as with the `auth` profile.
- Route the **sender** (open) hostname to `127.0.0.1:7395` (websend) and, on that host, **(a)** return `403` for `POST /api/rooms` (senders never create rooms), and **(b)** strip any client-supplied `AUTH_IDENTITY_HEADER`.
- On **both** hostnames, never let a client set the identity header; only oauth2-proxy may. The `auth-split` proxy sets `OAUTH2_PROXY_SET_XAUTHREQUEST=true` so it emits `X-Auth-Request-User`.
- Set `SENDER_PUBLIC_ORIGIN` to the open hostname's origin and add it to `ALLOWED_ORIGINS`. The receiver's QR/invite link is built against it (so the sender lands on the open host, not the SSO login), and the server aborts at boot if it is missing or not whitelisted. The link stays same-origin from the sender's perspective, so the QR phishing defense is unaffected.

This feature was added with assistance from [Claude Code](https://claude.ai/claude-code).

## Requirements

- Docker and Docker Compose
- HTTPS (required for camera access in browsers) -- I recommend [Caddy](https://caddyserver.com/) as a reverse proxy for automatic Let's Encrypt certificates
- The devices must be able to reach each other (same network, or TURN/TURNS relay)

## Quick Start

0. Go to `./docker`

1. Copy the environment file and configure your domain/IP:
   ```bash
   cp env.example .env
   # Edit .env and set DOMAIN to your server's IP or hostname
   ```

2. Pick which services to run by setting `COMPOSE_PROFILES` in `.env`. The provided template defaults to `direct,turn` (websend bound to `127.0.0.1:7395` plus the bundled coturn). See [Compose Profiles](#compose-profiles) for the full table and other combinations (e.g. `auth,turn` for SSO).

   > **Upgrading from v4.2 or earlier?** Service activation moved from "comment / uncomment YAML" to `COMPOSE_PROFILES`. If you `docker compose up -d` and nothing starts, add a line like `COMPOSE_PROFILES=direct,turn` to your `.env`.

3. Start the services:
   ```bash
   docker compose up -d
   ```

4. Set up [Caddy](https://caddyserver.com/) (or another reverse proxy) to terminate HTTPS and proxy to port 7395 (or 4180 if you use the `auth` profile).

5. Access the app at `https://your-domain`

## Configuration

All configuration is done via environment variables in `docker/.env` (see `docker/env.example` for documentation). Docker Compose automatically loads `.env` and substitutes variables into `docker-compose.yml`.

**Important**: after changing `.env`, you must run `docker compose up -d` (not `docker compose restart`) for changes to take effect, because `restart` reuses the existing container with old environment values.

### Compose Profiles

Every service in `docker-compose.yml` is opt-in via a [Docker Compose profile](https://docs.docker.com/compose/profiles/) selected by the `COMPOSE_PROFILES` env var. With no profile set, `docker compose up -d` starts nothing.

| Profile | Brings up | Use case |
|---------|-----------|----------|
| `direct` | `websend` bound to `127.0.0.1:7395` | Local / LAN / trusted-network deploys, Caddy fronts websend directly |
| `auth`   | `websend` (no host port) + `oauth2-proxy` on `127.0.0.1:4180` | Public deploys gated behind Keycloak SSO for **all** peers |
| `auth-split` | `websend` on `127.0.0.1:7395` (open, sender) + `oauth2-proxy` on `127.0.0.1:4180` (gated, receiver) | Receiver-only SSO: receiver inside a corporate network, external sender. See [Receiver-only authentication](#receiver-only-authentication-experimental) |
| `turn`   | bundled `coturn` TURN relay | Anyone using the in-repo TURN server (skip if you have an external one) |

Typical combinations to put in `.env`:

```
COMPOSE_PROFILES=direct           # local / LAN, external TURN
COMPOSE_PROFILES=direct,turn      # local / LAN with bundled TURN
COMPOSE_PROFILES=auth             # public with SSO, external TURN
COMPOSE_PROFILES=auth,turn        # public with SSO and bundled TURN
COMPOSE_PROFILES=auth-split       # receiver-only SSO (two hosts), external TURN
```

`direct`, `auth` and `auth-split` are mutually exclusive: all define `container_name: websend`, so Compose refuses to start more than one at once. For `direct` and `auth` that refusal is the safety property that makes it impossible to leave websend exposed on `127.0.0.1:7395` while the oauth2-proxy gate is also running (the failure mode the old "comment out the ports block" instructions tried to prevent by hand). `auth-split` deliberately runs both at once and replaces that invariant with the room-creation gate described under [Receiver-only authentication](#receiver-only-authentication-experimental).

| Variable | Description | Default |
|----------|-------------|---------|
| `DOMAIN` | Server IP or hostname | `localhost` |
| `ALLOWED_ORIGINS` | Comma-separated allowed origins for API requests | `https://{DOMAIN}` (the cleartext `http://{DOMAIN}` is added only when `DOMAIN=localhost`) |
| `HSTS_MAX_AGE` | `Strict-Transport-Security` max-age in seconds, sent only on connections the server sees as HTTPS. `0` disables the header | `31536000` (1 year) |
| `DEV` | Enable verbose debug logging (`1` or `0`) | `0` |
| `STUN_SERVER` | Self-hosted STUN server (`host:port`) | _(empty -- uses Google STUN)_ |
| `STUN_GOOGLE_FALLBACK` | Use Google's public STUN as fallback | `true` |
| `TURN_SERVER` | TURN relay server (`host:port`) | _(empty -- no relay)_ |
| `TURN_SECRET` | Shared secret for TURN time-based credentials | _(empty)_ |
| `TURN_CREDENTIAL_TTL` | TURN credential validity in seconds | `3600` (1h) |
| `TURNS_PORT` | Public TURN-over-TLS (TURNS) port advertised to clients; this is the port the reverse proxy listens on (typically `443`), not coturn's internal port. Enables `turns:` ICE candidates | _(empty -- TURNS disabled)_ |
| `UMAMI_URL` | Base URL of your [Umami](https://umami.is/) analytics instance | _(empty -- analytics disabled)_ |
| `UMAMI_WEBSITE_ID` | Website ID from your Umami dashboard (UUID) | _(empty)_ |
| `UMAMI_DNT` | Respect browser Do Not Track setting (`true` or `false`) | `true` |
| `RUN_NPM_AUDIT` | Run `npm audit --audit-level=high` during `docker build` (build arg) | `false` |
| `ALLOWED_FILE_TYPES` | Restrict accepted uploads: `ONLY_IMAGES`, `IMAGE_OR_PDF`, or `ANY` | `ANY` |
| `OCR_LANGS` | Tesseract languages used by the receiver's OCR (comma-separated) | `eng,fra` |
| `OCR_PSM` | Tesseract page-segmentation mode | `12` |
| `TURN_TIMEOUT` | Seconds the client waits for the WebRTC connection to establish before giving up | `15` |
| `DEV_FORCE_CONNECTION` | Force `DIRECT`, `RELAY_HTTPS`, `RELAY_LP`, or other ICE policy for testing (otherwise `DEFAULT`) | `DEFAULT` |
| `RELAY_ENABLE` | Expose the HTTP-relay fallback transport (WebSocket + long-poll). Set to `false` to disable | `true` |
| `RELAY_LP_ONLY` | Force long-poll-only transport: suppresses WebRTC ICE servers and 404s the WS relay endpoint so clients only use the long-poll path. Requires `RELAY_ENABLE=true` | `false` |
| `PORT` | HTTP port the Node server listens on inside the container | `8080` |
| `TRUST_PROXY` | Comma-separated [Express trust-proxy](https://expressjs.com/en/guide/behind-proxies.html) specifiers. Automatically set to `loopback,linklocal,uniquelocal` by the `auth` compose profile; only override if you have extra proxy hops upstream of Caddy | `loopback` (`direct`) / `loopback,linklocal,uniquelocal` (`auth`) |
| `AUTH_SCOPE` | `both` gates every peer behind SSO; `receiver` gates only the room creator and leaves the sender on an open host. See [Receiver-only authentication](#receiver-only-authentication-experimental) | `both` |
| `SENDER_PUBLIC_ORIGIN` | Required when `AUTH_SCOPE=receiver`: the open sender host's origin (`scheme://host[:port]`) the receiver's QR/invite link targets. Must also be in `ALLOWED_ORIGINS` (server aborts at boot otherwise) | _(empty)_ |
| `AUTH_IDENTITY_HEADER` | The proxy-injected identity header the room-creation gate checks when `AUTH_SCOPE=receiver` | `x-auth-request-user` |
| `TEST_DISABLE_RATE_LIMIT` | Disable per-IP rate limiting (test escape hatch only) | _(unset)_ |

## Firewall (UFW)

If you use UFW, you need to open the ports used by coturn. Note that Docker bypasses UFW's iptables rules by default, so standard `ufw allow` commands won't work for containers.

It is recommended to use [ufw-docker](https://github.com/chaifeng/ufw-docker) which manages UFW rules that actually apply to Docker containers.

```bash
# TURN listening port (UDP + TCP)
# Note: when TURNS is enabled, it is fronted by the reverse proxy on port 443
# (see the "TURN Relay Security" section) and the proxy forwards plaintext to
# coturn:3478/tcp. There is no separate TURNS port to open on coturn.
sudo ufw-docker allow coturn 3478/udp
sudo ufw-docker allow coturn 3478/tcp

# TURN relay ports -- ufw-docker does not support port ranges,
# so each port in the relay range must be allowed individually.
# Adjust to match --min-port / --max-port in your coturn config.
sudo ufw-docker allow coturn 49152/udp
sudo ufw-docker allow coturn 49153/udp
sudo ufw-docker allow coturn 49154/udp
sudo ufw-docker allow coturn 49155/udp
sudo ufw-docker allow coturn 49156/udp
sudo ufw-docker allow coturn 49157/udp
sudo ufw-docker allow coturn 49158/udp
sudo ufw-docker allow coturn 49159/udp
sudo ufw-docker allow coturn 49160/udp
sudo ufw-docker allow coturn 49161/udp
```

> **Note**: Replace `coturn` with your actual container name (e.g., `docker-coturn-1`) if it differs. Check with `docker ps`.

## Troubleshooting

- **Camera not working**: make sure you're using HTTPS. Browsers require a secure context for camera access. Set up [Caddy](https://caddyserver.com/) or another reverse proxy for automatic HTTPS.
- **Connection failing**: check that both devices can reach the server. If behind symmetric NAT, enable the TURN relay (see `env.example`). Check firewall rules for UDP traffic. A good way to test your network's STUN/TURN/TURNS capabilities is [Twilio's Network Test](https://networktest.twilio.com/).
- **TURN/TURNS not reachable**: use `misc/check_turn.py` to verify that your TURN or TURNS server is up and responding. It sends an unauthenticated Allocate request and reports whether the server answers correctly (a 401 response means the server is alive and asking for credentials, which is the expected behaviour):
  ```bash
  uv run misc/check_turn.py --turns-server myrelay.example.com 5349
  uv run misc/check_turn.py --turn-server  myrelay.example.com 3478
  ```
- **Diagnosing failed sessions from the logs**: the in-page logs panel (Logs button on sender and receiver) now distinguishes STUN / TURN / TURNS individually instead of lumping them. Useful lines to look for:
  - **Startup of the server**: `ICE URLs offered to clients: STUN=N, TURN=N, TURNS=N` followed by every URL. If `TURNS=0`, no `turns:` will be offered to clients (set `TURNS_PORT`).
  - **Client init**: `ICE breakdown: STUN=N, TURN=N, TURNS=N`. Tells you what the server handed this session.
  - **Per-candidate gather**: `ICE candidate: relay via TURNS(TLS) turns:host:5349` confirms TURNS actually produced a candidate.
  - **Per-server failure**: `ICE error from turns:host:5349: code=401 "Unauthorized" :: TURNS: credentials rejected by server. Check that TURN_SECRET on WebSend matches coturn's static-auth-secret`. The code maps to a tailored cause (401 = coturn auth, 403 = ACL, 701 = DNS, >=700 = network unreachable / TLS handshake / port blocked).
  - **On disconnect**: a `CONNECTION FAILURE DIAGNOSTICS` block lists configured URLs, gathered local candidates (with `relay/udp`, `relay/tcp`, `relay/tls` broken out), remote candidates, and every candidate pair with `state`, `nominated`, `requestsSent`, `responsesReceived`, and RTT. A pair with `reqSent>0 respRcvd=0` means the peer dropped our STUN probes (firewall on their side).
  - Whenever a session fails, a per-server probe report (`[DIAG] turns:host:5349 -- reachable / UNREACHABLE`) is appended even outside `DEV=1`.
- **QR code not scanning**: ensure good lighting and that the QR code is fully visible. The QR code contains a URL with a security token.
- **Click "Logs" button**: both sender and receiver pages have a logs panel for detailed connection debugging. Set `DEV=1` in `.env` for verbose output.

## Tech Stack

- **Express.js** (5.x) -- static file server + signaling API
- **Web Crypto API** -- ECDH key exchange + AES-256-GCM encryption
- **WebRTC** -- peer-to-peer data channels
- **jsQR / qrcode.js** -- QR code scanning and generation
- **scribe.js-ocr / Tesseract WASM / MuPDF** -- OCR and PDF rendering, all vendored
- **client-zip** -- streaming ZIP generation in the browser
- **eruda** -- on-demand mobile devtools console (loaded only via `?debug=1` or DEV badge)
- **coturn** -- optional TURN relay server (can reuse an existing instance)
- **Docker** -- containerized deployment

## Development

Built with assistance from [Claude Code](https://claude.ai/claude-code) (AI-assisted development).

### Testing

The project uses a three-tier test suite:

| Tier | Command | What it covers | Speed |
|------|---------|----------------|-------|
| Unit | `npm run test:unit` | Pure JS modules: crypto, image transforms, server helpers, transfer stats, SRI updater, hand-rolled PDF builder, and a real-photo regression suite for the document-edge detector (`doc-detect-samples.test.mjs`, gated on the optional `canvas` devDep) | ~0.5s |
| HTTP integration | `npm run test:http` | Real `server.js` spawned per file via child_process — config, origin validation, rate limiting, room/ICE/SDP signaling, long-poll edge cases, static asset mounts, env-var propagation | ~2s |
| End-to-end | `npm run test:e2e` | Two real browsers via Playwright (sender + receiver round-trip) | ~30s |

Run `npm test` (= unit + HTTP) for the fast inner loop, or `npm run test:all` for everything. A pre-push git hook (in `.githooks/pre-push`, auto-wired by `npm install` via the `prepare` script) runs `npm test` before every push.

Known testing gaps (frontend modules like `webrtc.js`/`logger.js`/`i18n.js`, the export modal, crop tool, transform-replay protocol, fingerprint-mismatch / integrity-retry paths, the service worker, healthcheck, and SSO) are listed in [ARCHITECTURE.md](ARCHITECTURE.md#testing).

### CLI receiver (advanced)

A minimal Node script `src/cli/receive.js` pairs as a receiver from a terminal — useful for remote-instance smoke testing and headless captures. It reuses the production `crypto.js` + `protocol.js` + `segment-stream.js` verbatim by driving them inside a Playwright-launched headless Chromium (already a devDependency for the e2e tests), so no native node-webrtc dependency is added and the wire protocol cannot drift. See [src/cli/README.md](src/cli/README.md) for usage. Not intended for end users.

## Third-Party Libraries

All client-side libraries are vendored directly in the repository (no CDN at runtime). All licenses are compatible with AGPL-3.0.

| Library | Version | License | Source |
|---------|---------|---------|--------|
| [qrcode.js](https://github.com/soldair/node-qrcode) | 1.5.1 | MIT | QR code generation |
| [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | Apache-2.0 | QR code scanning |
| [client-zip](https://github.com/Touffy/client-zip) | — | MIT | ZIP export |
| [scribe.js-ocr](https://github.com/scribeocr/scribe.js) | 0.10.1 | AGPL-3.0 | OCR engine (preloaded in background; bundles Tesseract WASM and MuPDF) |
| [Tesseract trained data](https://github.com/tesseract-ocr/tessdata) | — | Apache-2.0 | `eng` + `fra` language models, served locally |
| [eruda](https://github.com/liriliri/eruda) | — | MIT | Mobile devtools console (on-demand) |
| [Express.js](https://expressjs.com) | ^5.0.0 | MIT | Server-side HTTP framework |

## License

[AGPLv3](LICENSE)
