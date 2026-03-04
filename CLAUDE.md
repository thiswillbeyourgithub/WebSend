## Project Goal

The ultimate goal is to have a secure and simple webapp to scan medical documents from an unsecure phone (e.g., a nurse's personal smartphone) to a secure medical hospital computer that can then upload to its ERP/EMR system. Patient data privacy is paramount - documents must be end-to-end encrypted and never stored on untrusted devices or servers.

---

Okay I want you to create a proof of concept app.

I want a docker-compose.yml file to build and launch a container called phone_share.

It needs to run a simple web server that shows two buttons: "Receive" and "Send".

## Receiver flow (typically a computer, no camera):
1. User clicks "Receive"
2. Generate a public/private key pair (for end-to-end encryption of photos)
3. Create a "room" on the server, get a short room ID
4. Generate SDP offer for WebRTC, send it to the server associated with the room ID
5. Display a QR code containing a **full URL** like `https://DOMAIN/send/ROOMID`
6. Wait for the sender to connect via the signaling server

## Sender flow (typically a smartphone with camera):
The sender can enter "send mode" in two ways:
- Clicking "Send" on the homepage, then scanning the QR code with the in-browser camera
- **OR** scanning the QR code directly with any barcode scanner app (the URL opens the browser directly in sender mode)

Once in sender mode:
1. Connect to the server using the room ID from the URL
2. Retrieve the receiver's SDP offer from the server
3. Create SDP answer, send it to the server
4. Server relays the answer to the receiver
5. WebRTC P2P connection is established

## Signaling server
The web server acts as a simple signaling server (relays SDP offer/answer between peers). This is standard WebRTC practice and is secure because:
- SDP data is not secret (just connection metadata)
- WebRTC uses DTLS-SRTP encryption negotiated directly between peers
- The server never sees the encryption keys or the actual photo data

## WebRTC connection
Use WebRTC for the data channel. Try direct P2P first (STUN), but fallback to a TURN relay via a second container (coturn) if direct connection fails. The photos are encrypted before being sent over WebRTC anyway, so even the TURN server only sees encrypted blobs.

Use an environment variable `DOMAIN` (e.g., `DOMAIN=192.168.1.50` or `DOMAIN=myserver.example.com`) to configure the server address and WebRTC ICE servers.

## After connection is established:
1. Receiver sends its public key to the sender over the WebRTC data channel
2. Sender can either:
   - Take pictures using the browser camera (important: no camera app, pictures stay in browser memory only)
   - **OR** select existing pictures from their gallery
3. Each picture is encrypted using hybrid encryption (asymmetric to encrypt a symmetric key)
4. Encrypted picture is sent through the WebRTC tunnel to the receiver
5. Receiver decrypts and offers the image for download
6. Sender returns to camera/gallery view to send more pictures

## Technical constraints:
- No heavy frameworks (no React, etc.) - use simple HTML5 + vanilla JS
- UI must be very simple with large buttons, usable by older folks
- Include a "Logs" button on both ends to display debug information for troubleshooting
- Hybrid symmetric encryption is fine (asymmetric encrypts a symmetric key, symmetric encrypts the data)
- Assume HTTPS is working

## Deployment

The app is expected to run behind a **Caddy** reverse proxy which handles:
- HTTPS termination (automatic certificates via Let's Encrypt)
- Adding `X-Forwarded-For` headers with the real client IP

The Express server must be configured to trust proxy headers only from Caddy (localhost/Docker network), not from arbitrary clients. This prevents attackers from spoofing their IP to bypass rate limiting.

## Before committing

Always run `node update-sri.js` to regenerate SRI hashes before every commit. The HTML files use Subresource Integrity attributes that must match the current JS/CSS files.
