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
  - [Metadata Protection](#metadata-protection)
  - [Transfer Verification](#transfer-verification)
  - [No Phone Storage](#no-phone-storage)
  - [Cross-Session Data Isolation](#cross-session-data-isolation)
  - [Docker Hardening](#docker-hardening)
  - [Subresource Integrity (SRI)](#subresource-integrity-sri)
  - [TURN Relay Security](#turn-relay-security)
- [Non-Security Features](#non-security-features)
- [Keycloak SSO (Experimental)](#keycloak-sso-experimental)
- [Future Ideas](#future-ideas)
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
6. **Receiver** decrypts, previews, optionally crops/rotates/binarizes, and downloads the photos — individually, as a ZIP, or as a single PDF (plain or searchable via OCR). Photos are auto-grouped into "collections" (one per sender batch). The sender side also exposes a Genius-Scan-like gallery (rotate, flip, B&W, perspective crop, drag-and-drop reorder) before the photos are sent

## Security Features

### End-to-End Encryption
- **ECDH key exchange** (P-256 curve) with **AES-256-GCM** encryption via the Web Crypto API
- **Forward secrecy**: fresh ephemeral key pairs are generated for each session, so compromising a key later does not expose past sessions
- **HKDF key derivation** with domain separation to derive AES keys from the ECDH shared secret

### Zero Server Trust
- The server acts as a **signaling relay only** (exchanges SDP connection metadata between peers)
- The server **never sees encryption keys, plaintext photos, or file metadata**
- All photo data travels **peer-to-peer** via WebRTC data channels (or encrypted through TURN/TURNS if relaying is needed)
- Rooms and signaling data are **ephemeral** (10-minute TTL, stored in memory only)

### Supply Chain Attack Resistance
- **No frameworks, no bundlers, no build tools**: the entire frontend is vanilla HTML, CSS, and JavaScript -- there is no `node_modules` in the browser, no transpilation step, and no dependency tree that could be poisoned
- All third-party client-side libraries are vendored directly into the repository (not pulled from npm or a CDN at runtime) — see [Third-Party Libraries](#third-party-libraries) below
- **Subresource Integrity (SRI)** hashes on all local `<script>` and `<link>` tags ensure that even a compromised server cannot silently swap in tampered files
- The server-side dependency footprint is intentionally minimal (Express.js only)

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
- **Per-IP rate limiting** on room creation (5/min), room lookups (30/min), and general API calls (100/min) to prevent DoS and enumeration. The general 100/min cap also covers `GET /api/rooms/:id/answer?wait=true` so a peer holding a valid secret cannot pipeline long-polls to exhaust memory.
- **Origin header validation** blocks cross-origin API requests from unauthorized websites (CSRF-like protection)
- Express **trusts proxy headers only from loopback**, so `X-Forwarded-For` cannot be spoofed by external clients (designed to run behind [Caddy](https://caddyserver.com/))
- **Long-poll waiter caps**: layered defense for `?wait=true`. A per-room cap (4 concurrent waiters) refuses extras with 429, and a process-wide ceiling (10000 in-flight waiters) refuses extras with 503, before any socket / closure / timer is allocated.

### Receiver Payload Bounding (Anti-DoS)
- The data-channel binary branch refuses chunks that arrive before a valid `file-start`, refuses any chunk that would push the in-flight file past its declared size, and refuses any chunk that would push the cumulative session bytes past 4 GiB. On any of those, the data channel and peer connection are torn down immediately.
- The `file-start` size validator enforces a 16 KiB floor (the smallest legitimate padded ciphertext) so a hostile peer cannot smuggle a tiny declared size to keep the receive buffer growing under the radar.
- These caps fire at the WebRTC layer, before fingerprint verification, so a not-yet-verified peer cannot OOM the receiver tab while the verification modal is up.

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

### Metadata Protection
- File metadata (name, MIME type, original size) is **encrypted inside the payload**, not sent in plaintext over the data channel
- Encrypted payloads are **padded to fixed bucket sizes** (16 KB to 32 MB, power-of-2) to hide the exact file size from network observers
- Padding uses **random bytes** (not zeros) to prevent compression-based attacks

### Transfer Verification
- After decryption, the receiver computes a **SHA-256 checksum** of the plaintext data and sends it back to the sender via a `file-ack` message
- The sender compares this against its own pre-encryption hash to **verify end-to-end integrity** (encryption, transfer, and decryption all succeeded)
- If verification fails or times out, the sender is notified and can **retry** without losing the photo

### No Phone Storage
- Photos are captured directly in the browser (no camera app) and **stay in browser memory only**
- Photos are never written to the phone's gallery, filesystem, or local storage
- Photos are kept in memory until the receiver confirms successful receipt — only then are they cleared

### Cross-Session Data Isolation
- A **new pairing on either device shreds all in-memory user data** (decrypted images, OCR text, preBW pixel buffers, blob URLs, scribe WASM state, crypto keys) before establishing the new session
- **Sender**: scanning a QR with a different `roomId` triggers a confirm prompt (when the gallery is non-empty) and then a local shred. The same-room reconnect path keeps the gallery intact, so a phone can re-pair after a network blip without losing unsent photos
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
- Anti-DoS caps are mirrored server-side: 4 GiB `MAX_TOTAL_SESSION_BYTES`, 16 KiB `MAX_CONTROL_MSG_BYTES`, plus a 32-frame bounded queue and 60 s idle timeout on the long-poll slots. Long-poll slot tokens (128-bit random) are validated in constant time alongside the room secret.
- The sidebar shows the active path: **Direct**, **Relay (TURN)**, **Relay (TURNS)**, **Relay (HTTP)**, or **Relay (HTTPS)**.
- Disable by setting `RELAY_ENABLE=false` on the server (default is `true`).

## Non-Security Features

- **PWA (Progressive Web App)**: installable on mobile home screens, with service worker for fast UI shell loading and an auto-reload on each deploy (the cache name is timestamped during SRI regeneration)
- **Internationalization (i18n)**: supports English and French, auto-detected from browser locale
- **Live document edge detection** on the sender camera: pure-JS pipeline (downscale → Sobel → Otsu → contour trace → multi-candidate quad fitting scored by perimeter edge alignment) overlays a green outline of the detected page in real time, and pre-fills corner positions when entering the crop tool
- **Sender-side gallery (Genius-Scan-like)**: thumbnail grid with per-photo rotate / flip / B&W / perspective crop, drag-and-drop reorder, and batch finalization before sending
- **Transform replay**: when the sender edits an already-sent photo, only a small `transform-image` command is re-encrypted and re-sent rather than the full image; the receiver replays the transforms against its stored original (with a `transform-nack` fallback that triggers a full resend)
- **Receiver collections**: photos are auto-grouped per sender batch and shown as "Document N" sections, supporting drag-and-drop reorder and per-collection PDF/ZIP export
- **Document cropping**: perspective-corrected 4-corner crop tool, shared between sender and receiver via a single `crop-modal.js` module so the logic isn't duplicated
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

WebSend can be placed behind [Keycloak](https://www.keycloak.org/) authentication using [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/). This provides a simple "authenticated or not" gate — only users who log in via Keycloak can access the app. No user, group, or permission mapping is performed.

A commented-out oauth2-proxy service is included in `docker-compose.yml` along with corresponding environment variables in `env.example`. This feature was added with assistance from [Claude Code](https://claude.ai/claude-code).

**Status**: Experimental. WebSocket signaling should work through oauth2-proxy, but long-lived connections may break when OAuth tokens expire. Token lifetime tuning in Keycloak may be required. coturn (TURN/TURNS/STUN) traffic is not protected by oauth2-proxy (it uses UDP/TCP, not HTTP), but is indirectly secured because unauthenticated users cannot obtain TURN/TURNS credentials.

## Future Ideas

Ideally, the WebRTC signaling server would be replaced by [iroh](https://iroh.computer/) in the future, which would eliminate the need for a signaling server entirely. However, iroh is not yet easy to embed in phone browsers.

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

2. Start the services:
   ```bash
   docker compose up -d
   ```

3. Set up [Caddy](https://caddyserver.com/) (or another reverse proxy) to terminate HTTPS and proxy to port 7395

4. Access the app at `https://your-domain`

## Configuration

All configuration is done via environment variables in `docker/.env` (see `docker/env.example` for documentation). Docker Compose automatically loads `.env` and substitutes variables into `docker-compose.yml`.

**Important**: after changing `.env`, you must run `docker compose up -d` (not `docker compose restart`) for changes to take effect, because `restart` reuses the existing container with old environment values.

| Variable | Description | Default |
|----------|-------------|---------|
| `DOMAIN` | Server IP or hostname | `localhost` |
| `ALLOWED_ORIGINS` | Comma-separated allowed origins for API requests | `https://{DOMAIN}, http://{DOMAIN}` |
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
| `TURN_TIMEOUT` | Seconds the client waits for TURN ICE candidates before giving up | `15` |
| `DEV_FORCE_CONNECTION` | Force `DIRECT` or `RELAY` ICE policy for testing (otherwise `DEFAULT`) | `DEFAULT` |
| `PORT` | HTTP port the Node server listens on inside the container | `8080` |
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

A minimal Node script `src/cli/receive.js` pairs as a receiver from a terminal — useful for remote-instance smoke testing and headless captures. It reuses the production `crypto.js` + `protocol.js` verbatim by driving them inside a Playwright-launched headless Chromium (already a devDependency for the e2e tests), so no native node-webrtc dependency is added and the wire protocol cannot drift. See [src/cli/README.md](src/cli/README.md) for usage. Not intended for end users.

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
