# ImageSecureSend

> **⚠️ WARNING: WORK IN PROGRESS ⚠️**
> 
> **This project is not ready for production use. Do not use it yet. Breaking changes will come.**
> 
> This codebase has not been audited by security professionals. While built with security best practices in mind, it may contain vulnerabilities. Use at your own risk.

**Use your regular smartphone as a secure document scanner** -- even for sensitive documents.

ImageSecureSend transfers photos directly between devices using WebRTC and end-to-end encryption. Photos are encrypted on the sender's device and decrypted only on the receiver's device. They never pass through any server unencrypted, and they never touch the phone's storage.

## Disclaimer

This project was developed with AI assistance ([Claude Code](https://claude.ai/claude-code)) with careful attention to security, but by someone without a formal background in computer science or security research.

## How It Works

1. **Receiver** (typically a computer) opens the app and clicks "Receive" -- generates encryption keys and displays a QR code
2. **Sender** (typically a smartphone) scans the QR code -- either by clicking "Send" and using the in-browser camera, or by scanning directly with any barcode scanner app (the URL opens the browser directly in sender mode)
3. A **direct peer-to-peer connection** is established via WebRTC
4. Both parties **verify key fingerprints** by reading short codes aloud to each other
5. **Sender** takes or selects photos, which are encrypted and sent directly
6. **Receiver** decrypts, previews, optionally crops, and downloads the photos (individually or as a PDF)

## Security Features

### End-to-End Encryption
- **ECDH key exchange** (P-256 curve) with **AES-256-GCM** encryption via the Web Crypto API
- **Forward secrecy**: fresh ephemeral key pairs are generated for each session, so compromising a key later does not expose past sessions
- **HKDF key derivation** with domain separation to derive AES keys from the ECDH shared secret

### Zero Server Trust
- The server acts as a **signaling relay only** (exchanges SDP connection metadata between peers)
- The server **never sees encryption keys, plaintext photos, or file metadata**
- All photo data travels **peer-to-peer** via WebRTC data channels (or encrypted through TURN if relaying is needed)
- Rooms and signaling data are **ephemeral** (10-minute TTL, stored in memory only)

### Man-in-the-Middle Protection
- **Key fingerprint verification**: after connection, both parties see short fingerprint codes (SHA-256 hash of public keys) that they can compare aloud to confirm no MITM key substitution occurred
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

### No Phone Storage
- Photos are captured directly in the browser (no camera app) and **stay in browser memory only**
- Photos are never written to the phone's gallery, filesystem, or local storage

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

## Non-Security Features

- **PWA (Progressive Web App)**: installable on mobile home screens, with service worker for fast UI shell loading
- **Internationalization (i18n)**: supports English and French, auto-detected from browser locale
- **Document cropping**: perspective-corrected 4-corner crop tool on the receiver side (pure vanilla JS, no dependencies)
- **PDF export**: download all received images as a single PDF (hand-crafted minimal PDF generator, no dependencies)
- **QR code scanning**: in-browser QR code scanning (jsQR) and generation (qrcode.js)
- **Connection type detection**: shows whether the connection is direct (local network or via STUN) or relayed (TURN)
- **Debug logging**: "Logs" button on both sender and receiver pages for troubleshooting, with optional verbose DEV mode
- **Large button UI**: designed for usability by non-technical users
- **No heavy frameworks**: vanilla HTML5 + CSS + JavaScript only

## Future Ideas

Ideally, the WebRTC signaling server would be replaced by [iroh](https://iroh.computer/) in the future, which would eliminate the need for a signaling server entirely. However, iroh is not yet easy to embed in phone browsers.

## Requirements

- Docker and Docker Compose
- HTTPS (required for camera access in browsers) -- I recommend [Caddy](https://caddyserver.com/) as a reverse proxy for automatic Let's Encrypt certificates
- The devices must be able to reach each other (same network, or TURN relay)

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
| `TURN_CREDENTIAL_TTL` | TURN credential validity in seconds | `86400` (24h) |
| `TURNS_PORT` | TURN-over-TLS (TURNS) port; enables `turns:` ICE candidates | _(empty -- TURNS disabled)_ |

## Troubleshooting

- **Camera not working**: make sure you're using HTTPS. Browsers require a secure context for camera access. Set up [Caddy](https://caddyserver.com/) or another reverse proxy for automatic HTTPS.
- **Connection failing**: check that both devices can reach the server. If behind symmetric NAT, enable the TURN relay (see `env.example`). Check firewall rules for UDP traffic. A good way to test your network's STUN/TURN/TURNS capabilities is [Twilio's Network Test](https://networktest.twilio.com/).
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

## License

[AGPLv3](LICENSE)
