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
  - [Metadata Protection](#metadata-protection)
  - [Transfer Verification](#transfer-verification)
  - [No Phone Storage](#no-phone-storage)
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
6. **Receiver** decrypts, previews, optionally crops, and downloads the photos (individually or as a PDF, with experimental OCR)

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
- **Key fingerprint verification**: after connection, both parties see short fingerprint codes (SHA-256 hash of public keys) that they can compare aloud to confirm no MITM key substitution occurred
- **Adaptive fingerprint length**: the fingerprint code length scales with the number of active rooms on the server (from 3 hex chars for a handful of rooms up to 12 for thousands), keeping codes short and easy to verify when traffic is low while maintaining collision resistance as concurrency grows
- Both parties must **explicitly confirm** the fingerprints match before photo transfer begins
- Either party can **abort** if fingerprints don't match

### Room Security
- Room IDs are short (6 characters) for usability, but each room also has a **128-bit cryptographic secret** (generated with `crypto.randomBytes`)
- The secret is embedded in the QR code URL's **hash fragment** (never sent to the server in HTTP requests)
- All room API calls require the secret via the `X-Room-Secret` header
- Secret comparison uses **constant-time comparison** (`crypto.timingSafeEqual`) to prevent timing attacks
- This prevents room enumeration and unauthorized room access even if an attacker guesses or brute-forces the short room ID

### Rate Limiting and Origin Validation
- **Per-IP rate limiting** on room creation (5/min), room lookups (30/min), and general API calls (100/min) to prevent DoS and enumeration
- **Origin header validation** blocks cross-origin API requests from unauthorized websites (CSRF-like protection)
- Express **trusts proxy headers only from loopback**, so `X-Forwarded-For` cannot be spoofed by external clients (designed to run behind [Caddy](https://caddyserver.com/))

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
- TURN credentials are **time-based** (HMAC-SHA1, standard coturn ephemeral credentials) and expire after a configurable TTL (default: 24 hours)
- Even when relayed through TURN, photos are still **end-to-end encrypted** -- the TURN server only sees encrypted blobs
- TURNS (TURN-over-TLS) requires TLS certificates; if you use **Caddy**, you can mount its managed certificates into the coturn container (see the commented example in `docker-compose.yml`)

## Non-Security Features

- **PWA (Progressive Web App)**: installable on mobile home screens, with service worker for fast UI shell loading
- **Internationalization (i18n)**: supports English and French, auto-detected from browser locale
- **Document cropping**: perspective-corrected 4-corner crop tool on the receiver side (pure vanilla JS, no dependencies)
- **Export modal**: download all received images as PDF or ZIP, with optional B&W (Otsu thresholding) and **experimental OCR** (scribe.js). OCR uses LSTM-only mode (instead of combined Legacy+LSTM) and downscales large images to 2000px for recognition to improve responsiveness, while preserving original image quality in the final PDF. These trade-offs were chosen with Claude Code to keep OCR usable in a browser context where processing time can otherwise reach ~1 min/image.
- **PDF export**: download all received images as a single PDF (hand-crafted minimal PDF generator, no dependencies)
- **ZIP export**: download all received images as a ZIP archive (client-zip, preloaded in background)
- **B&W document mode**: Otsu's automatic binarization for crisp scanned documents
- **QR code scanning**: in-browser QR code scanning (jsQR) and generation (qrcode.js)
- **Connection type detection**: shows whether the connection is direct (local network or via STUN) or relayed (TURN/TURNS)
- **Debug logging**: "Logs" button on both sender and receiver pages for troubleshooting, with optional verbose DEV mode
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
| `TURNS_PORT` | TURN-over-TLS (TURNS) port; enables `turns:` ICE candidates | _(empty -- TURNS disabled)_ |
| `UMAMI_URL` | Base URL of your [Umami](https://umami.is/) analytics instance | _(empty -- analytics disabled)_ |
| `UMAMI_WEBSITE_ID` | Website ID from your Umami dashboard (UUID) | _(empty)_ |
| `UMAMI_DNT` | Respect browser Do Not Track setting (`true` or `false`) | `true` |
| `RUN_NPM_AUDIT` | Run `npm audit --audit-level=high` during `docker build` (build arg) | `false` |

## Firewall (UFW)

If you use UFW, you need to open the ports used by coturn. Note that Docker bypasses UFW's iptables rules by default, so standard `ufw allow` commands won't work for containers.

It is recommended to use [ufw-docker](https://github.com/chaifeng/ufw-docker) which manages UFW rules that actually apply to Docker containers.

```bash
# TURN listening port (UDP + TCP)
sudo ufw-docker allow coturn 3478/udp
sudo ufw-docker allow coturn 3478/tcp

# TURNS (TURN-over-TLS) -- only if you enabled TURNS
sudo ufw-docker allow coturn 8443/tcp

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
- **QR code not scanning**: ensure good lighting and that the QR code is fully visible. The QR code contains a URL with a security token.
- **Click "Logs" button**: both sender and receiver pages have a logs panel for detailed connection debugging. Set `DEV=1` in `.env` for verbose output.

## Tech Stack

- **Express.js** -- static file server + signaling API
- **Web Crypto API** -- ECDH key exchange + AES-256-GCM encryption
- **WebRTC** -- peer-to-peer data channels
- **jsQR / qrcode.js** -- QR code scanning and generation
- **coturn** -- optional TURN relay server (can reuse an existing instance)
- **Docker** -- containerized deployment

## Development

Built with assistance from [Claude Code](https://claude.ai/claude-code) (AI-assisted development).

## Third-Party Libraries

All client-side libraries are vendored directly in the repository (no CDN at runtime). All licenses are compatible with AGPL-3.0.

| Library | Version | License | Source |
|---------|---------|---------|--------|
| [qrcode.js](https://github.com/soldair/node-qrcode) | 1.5.1 | MIT | QR code generation |
| [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | Apache-2.0 | QR code scanning |
| [client-zip](https://github.com/Touffy/client-zip) | — | MIT | ZIP export |
| [scribe.js-ocr](https://github.com/scribeocr/scribe.js) | 0.10.1 | AGPL-3.0 | OCR engine (preloaded in background) |
| [Express.js](https://expressjs.com) | 4.18.2 | MIT | Server-side HTTP framework |

## License

[AGPLv3](LICENSE)
