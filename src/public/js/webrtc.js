/**
 * WebRTC module for WebSend
 * Handles peer-to-peer connection establishment and data channel communication.
 * Uses server-based signaling for SDP exchange.
 */

/** Thrown when the room is gone (404) — should not trigger the retry loop. */
class RoomGoneError extends Error {
    constructor(msg = 'Room expired or not found') {
        super(msg);
        this.name = 'RoomGoneError';
    }
}

class WebSendRTC {
    constructor() {
        this.pc = null;
        this.dataChannel = null;
        this.iceServers = [];
        this.roomId = null;
        this.roomSecret = null; // Cryptographic secret for room access authorization
        this.isOfferer = false; // True for receiver, false for sender

        // Callbacks
        this.onConnected = null;
        this.onDisconnected = null;
        this.onMessage = null;
        this.onStateChange = null;
        this.onConnectionTypeDetected = null; // Called when we know if direct or relay

        // For chunked file transfer
        this.receiveBuffer = [];
        this.receivedSize = 0;
        this.expectedSize = 0;
        this._lastLoggedDecile = -1;

        // ICE candidate handling
        this.pendingIceCandidates = [];
        this.remoteDescriptionSet = false;

        // Transfer acknowledgment state — sendFile() returns a Promise that
        // resolves only when the receiver sends file-ack (or rejects on file-nack/timeout).
        // This ensures the sender knows the receiver successfully decrypted the data.
        this._fileAckResolve = null;
        this._fileAckReject = null;
        this._fileAckTimeout = null;
        this._FILE_ACK_TIMEOUT_MS = 30000; // 30s timeout for receiver to ack

        // ICE candidate polling state
        // After the initial fetch of remote candidates, we poll for newly trickled
        // candidates until the connection succeeds or fails. This is needed because
        // candidates arrive asynchronously and the one-shot fetch may miss late ones.
        this._icePollTimer = null;
        this._icePollRemoteSide = null; // 'offer' or 'answer' — the side we fetch from
        this._knownRemoteCandidateCount = 0;

        // Connection timeout — if WebRTC doesn't reach 'connected' or 'failed' within
        // this duration (e.g. TURN server unreachable), we force-fail instead of polling
        // forever. Configurable via TURN_TIMEOUT env var (default: 15s).
        this._connectionTimeout = null;
        this._CONNECTION_TIMEOUT_MS = 15000; // default, overridden by server config
    }

    /**
     * Build headers object with room secret for authenticated API calls.
     * All room-related endpoints require the X-Room-Secret header.
     * @param {Object} extraHeaders - Additional headers to include
     * @returns {Object} Headers object with X-Room-Secret
     */
    getAuthHeaders(extraHeaders = {}) {
        const headers = { ...extraHeaders };
        if (this.roomSecret) {
            headers['X-Room-Secret'] = this.roomSecret;
        }
        return headers;
    }

    /**
     * Initialize by fetching ICE server configuration from server
     */
    async init() {
        logger.info('Fetching ICE server configuration...');
        try {
            const response = await fetch('/api/config');
            const config = await response.json();
            this.iceServers = config.iceServers;
            // iceTransportPolicy: 'relay' forces TURN-only (set by DEV_FORCE_CONNECTION on server)
            this.iceTransportPolicy = config.iceTransportPolicy || 'all';
            // Enable DEV mode in logger if server has it enabled
            this._devMode = !!config.dev;
            if (config.dev) {
                logger.setDevMode(true);
            }
            if (config.forceConnection) {
                logger.warn(`DEV_FORCE_CONNECTION=${config.forceConnection} — ICE servers filtered for debugging`);
            }
            if (config.turnTimeout) {
                this._CONNECTION_TIMEOUT_MS = config.turnTimeout * 1000;
            }
            logger.success(`Got ${this.iceServers.length} ICE servers (transport policy: ${this.iceTransportPolicy})`);
            logger.debug('CONFIG', 'ICE servers loaded', { servers: this.iceServers, iceTransportPolicy: this.iceTransportPolicy });
            // Fire-and-forget ICE server reachability check (DEV mode only)
            this.diagnoseIceServers();
        } catch (e) {
            logger.warn('Failed to fetch config, using defaults: ' + e.message);
            this.iceServers = [
                { urls: 'stun:stun.l.google.com:19302' }
            ];
        }
    }

    /**
     * Create the RTCPeerConnection with configured ICE servers
     */
    createPeerConnection() {
        logger.info('Creating peer connection...');

        this.pc = new RTCPeerConnection({
            iceServers: this.iceServers,
            iceTransportPolicy: this.iceTransportPolicy
        });

        // Send trickle ICE candidates to server as a best-effort optimization.
        // These are redundant with the candidates already embedded in the SDP
        // (both sides call waitForICE() before storing their SDP offer/answer),
        // so lost POSTs or timing gaps in polling are harmless.
        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                const candidateInfo = event.candidate.type || 'unknown';
                logger.info(`ICE candidate: ${candidateInfo}`);
                logger.debug('ICE', 'Local candidate generated', {
                    type: event.candidate.type,
                    protocol: event.candidate.protocol,
                    address: event.candidate.address,
                    port: event.candidate.port,
                    candidateStr: event.candidate.candidate?.substring(0, 80)
                });

                // Send to server with room secret for authorization
                if (this.roomId) {
                    const endpoint = this.isOfferer ? 'offer' : 'answer';
                    fetch(`/api/rooms/${this.roomId}/ice/${endpoint}`, {
                        method: 'POST',
                        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify(event.candidate.toJSON())
                    }).catch(e => logger.warn('Failed to send ICE candidate: ' + e.message));
                }
            } else {
                logger.info('ICE gathering complete');
                logger.debug('ICE', 'Gathering finished, all candidates sent');
            }
        };

        // Monitor connection state
        this.pc.onconnectionstatechange = () => {
            const state = this.pc.connectionState;
            logger.info(`Connection state: ${state}`);
            logger.debug('CONNECTION', 'Peer connection state changed', {
                connectionState: state,
                iceConnectionState: this.pc.iceConnectionState,
                iceGatheringState: this.pc.iceGatheringState,
                signalingState: this.pc.signalingState
            });
            if (this.onStateChange) {
                this.onStateChange(state);
            }
            if (state === 'connected') {
                logger.success('Peer connection established!');
                // Cancel any pending disconnect grace timer (recovery from transient "disconnected")
                if (this._disconnectTimer) {
                    clearTimeout(this._disconnectTimer);
                    this._disconnectTimer = null;
                }
                this.stopIceCandidatePolling();
                if (this.onConnected) this.onConnected();
                this.detectConnectionType();
            } else if (state === 'failed') {
                // Gather diagnostic info to explain WHY the connection failed
                this._logConnectionFailure();
                if (this.onDisconnected) this.onDisconnected();
            } else if (state === 'disconnected') {
                // "disconnected" is often transient in WebRTC (ICE may recover).
                // Wait a grace period before treating it as terminal, to avoid
                // tearing down connections that could have self-healed.
                logger.warn('Peer connection disconnected — waiting 5s for recovery...');
                this._disconnectTimer = setTimeout(() => {
                    if (this.pc && this.pc.connectionState === 'disconnected') {
                        logger.error('Peer connection did not recover after 5s');
                        this._logConnectionFailure();
                        if (this.onDisconnected) this.onDisconnected();
                    }
                }, 5000);
            }
        };

        this.pc.oniceconnectionstatechange = () => {
            const iceState = this.pc.iceConnectionState;
            logger.info(`ICE connection state: ${iceState}`);
            logger.debug('ICE', 'ICE connection state changed', {
                iceConnectionState: iceState,
                connectionState: this.pc.connectionState
            });

            if (iceState === 'failed') {
                logger.error('ICE connection failed — no network path found between peers');
                logger.error('This typically means: both peers are behind symmetric NATs and no TURN server is configured');
            }
        };

        // Handle incoming data channel (for sender side when receiver creates one)
        this.pc.ondatachannel = (event) => {
            logger.info('Received data channel from peer');
            this.setupDataChannel(event.channel);
        };
    }

    /**
     * Set up the data channel with event handlers
     * @param {RTCDataChannel} channel
     */
    setupDataChannel(channel) {
        this.dataChannel = channel;
        this.dataChannel.binaryType = 'arraybuffer';
        logger.debug('DATACHANNEL', 'Setting up data channel', {
            label: channel.label,
            id: channel.id,
            ordered: channel.ordered,
            readyState: channel.readyState
        });

        this.dataChannel.onopen = () => {
            logger.success('Data channel open');
            logger.debug('DATACHANNEL', 'Channel opened', {
                label: channel.label,
                bufferedAmount: channel.bufferedAmount
            });
        };

        this.dataChannel.onclose = () => {
            logger.info('Data channel closed');
            logger.debug('DATACHANNEL', 'Channel closed');
        };

        this.dataChannel.onerror = (event) => {
            const errorMsg = event.error ? event.error.message : (event.message || 'Unknown error');
            logger.error('Data channel error: ' + errorMsg);
            logger.debug('DATACHANNEL', 'Channel error', { error: errorMsg });
        };

        this.dataChannel.onmessage = (event) => {
            this.handleMessage(event.data);
        };
    }

    /**
     * Handle incoming messages on the data channel.
     * File transfers now only reveal the padded encrypted size in the file-start
     * message. Actual metadata (name, type, original size) is encrypted inside
     * the payload and extracted by the application layer after decryption.
     *
     * @param {string|ArrayBuffer} data
     */
    handleMessage(data) {
        if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data);
                // Validate wire messages. 'progress' and 'encrypted-file' are local
                // synthetic events (never on the wire) so they bypass this path.
                const vr = Protocol.validate(msg);
                if (!vr.ok) {
                    logger.error('Dropping inbound message: ' + vr.error);
                    return;
                }
                logger.info(`Received message type: ${msg.type}`);

                if (msg.type === 'file-start') {
                    // File-start now only contains encrypted size (padded).
                    // Metadata is encrypted inside the payload.
                    this.receiveBuffer = [];
                    this.receivedSize = 0;
                    this.expectedSize = msg.size;
                    this._lastLoggedDecile = -1;
                    logger.info(`Receiving encrypted file (${msg.size} bytes, padded)`);
                } else if (msg.type === 'file-end') {
                    logger.info('File transfer complete, assembling...');
                    // Create blob with generic binary type - actual type is encrypted
                    const blob = new Blob(this.receiveBuffer, { type: 'application/octet-stream' });
                    if (this.onMessage) {
                        // Pass blob to application layer for decryption and metadata extraction
                        this.onMessage({
                            type: 'encrypted-file',
                            blob: blob
                        });
                    }
                    this.receiveBuffer = [];
                    this.receivedSize = 0;
                } else if (msg.type === 'file-ack') {
                    // Receiver confirmed successful decryption with their computed hash
                    logger.info(`Received file-ack with SHA-256: ${msg.sha256}`);
                    if (this._fileAckResolve) {
                        clearTimeout(this._fileAckTimeout);
                        this._fileAckResolve({ acknowledged: true, sha256: msg.sha256 });
                        this._fileAckResolve = null;
                        this._fileAckReject = null;
                    }
                } else if (msg.type === 'file-nack') {
                    // Receiver reported decryption failure
                    logger.error(`Received file-nack: ${msg.error}`);
                    if (this._fileAckReject) {
                        clearTimeout(this._fileAckTimeout);
                        this._fileAckReject(new Error(`Receiver decryption failed: ${msg.error}`));
                        this._fileAckResolve = null;
                        this._fileAckReject = null;
                    }
                } else {
                    if (this.onMessage) {
                        this.onMessage(msg);
                    }
                }
            } catch (e) {
                logger.error('Failed to parse message: ' + e.message);
            }
        } else {
            // Binary data (file chunk)
            this.receiveBuffer.push(data);
            this.receivedSize += data.byteLength;
            const decile = Math.floor((this.receivedSize / this.expectedSize) * 10) * 10;
            if (decile !== this._lastLoggedDecile) {
                this._lastLoggedDecile = decile;
                logger.info(`Receiving: ${decile}%`);
            }
            if (this.onMessage) {
                this.onMessage({
                    type: 'progress',
                    received: this.receivedSize,
                    total: this.expectedSize
                });
            }
        }
    }

    /**
     * Send a text message (JSON) over the data channel
     * @param {Object} message
     */
    sendMessage(message) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            logger.error('Data channel not open');
            return false;
        }
        const vr = Protocol.validate(message);
        if (!vr.ok) {
            logger.error('Refusing to send invalid message: ' + vr.error);
            return false;
        }
        this.dataChannel.send(JSON.stringify(message));
        return true;
    }

    /**
     * Send a file (binary) over the data channel.
     * The data should already be encrypted with metadata bundled via
     * WebSendCrypto.encryptWithMetadata() - this function only handles
     * chunked transfer and does not see any plaintext metadata.
     *
     * @param {ArrayBuffer} encryptedData - Already-encrypted data with metadata bundled
     * @param {Function} onProgress - Progress callback (percent)
     */
    async sendFile(encryptedData, onProgress) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            logger.error('Data channel not open');
            return false;
        }

        if (this._fileAckResolve) {
            throw new Error('sendFile already in progress — wait for the previous transfer to finish');
        }

        const CHUNK_SIZE = 16384; // 16KB chunks
        const totalSize = encryptedData.byteLength;
        let offset = 0;

        // File-start message contains only the encrypted size (which is padded).
        // No plaintext metadata is revealed - name, type, and original size
        // are encrypted inside the payload.
        this.sendMessage(Protocol.build.fileStart(totalSize));

        logger.info(`Sending encrypted file (${totalSize} bytes, padded)`);

        while (offset < totalSize) {
            while (this.dataChannel.bufferedAmount > 1024 * 1024) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            const chunk = encryptedData.slice(offset, offset + CHUNK_SIZE);
            this.dataChannel.send(chunk);
            offset += chunk.byteLength;

            const percent = Math.round((offset / totalSize) * 100);
            if (onProgress) onProgress(percent, offset, totalSize);
        }

        this.sendMessage(Protocol.build.fileEnd());
        logger.info('All chunks sent, waiting for receiver acknowledgment...');

        // Wait for file-ack / file-nack from receiver, or timeout.
        // This ensures the sender only sees "success" after the receiver
        // has confirmed successful decryption with a matching checksum.
        return new Promise((resolve, reject) => {
            this._fileAckResolve = resolve;
            this._fileAckReject = reject;
            this._fileAckTimeout = setTimeout(() => {
                if (this._fileAckReject) {
                    this._fileAckReject(new Error('Transfer acknowledgment timeout — no confirmation from receiver after 30s'));
                    this._fileAckResolve = null;
                    this._fileAckReject = null;
                }
            }, this._FILE_ACK_TIMEOUT_MS);
        });
    }

    // ============ Server-based Signaling ============

    /**
     * Create a room on the server (for receiver).
     * Returns both room ID and secret; secret is included in QR code URL.
     * @returns {Promise<{roomId: string, secret: string}>} Room ID and secret
     */
    async createRoom() {
        logger.debug('SIGNALING', 'Creating room...');
        const response = await fetch('/api/rooms', { method: 'POST' });
        const data = await response.json();
        this.roomId = data.roomId;
        this.roomSecret = data.secret;
        logger.info(`Created room: ${this.roomId}`);
        logger.debug('SIGNALING', 'Room created', { roomId: this.roomId });
        return { roomId: this.roomId, secret: this.roomSecret };
    }

    /**
     * Create an offer and store it on the server (for receiver)
     * @returns {Promise<string>} Room ID for QR code
     */
    async createOfferAndStore() {
        this.isOfferer = true;

        // Step 1: Create peer connection
        logger.info('[Step 1/4] Creating peer connection...');
        this.createPeerConnection();

        // Step 2: Create data channel and SDP offer
        logger.info('[Step 2/4] Creating data channel and SDP offer...');
        const dc = this.pc.createDataChannel('websend', { ordered: true });
        this.setupDataChannel(dc);

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        logger.info('[Step 2/4] Offer created, gathering ICE candidates...');
        logger.debug('SIGNALING', 'Local description set', {
            type: offer.type,
            sdpLength: offer.sdp?.length
        });

        // Step 3: Wait for ICE gathering
        logger.info('[Step 3/4] Waiting for ICE candidate gathering...');
        await this.waitForICE();

        // Step 4: Store offer on server
        logger.info('[Step 4/4] Storing offer on signaling server...');
        const fullOffer = {
            type: this.pc.localDescription.type,
            sdp: this.pc.localDescription.sdp
        };

        const response = await fetch(`/api/rooms/${this.roomId}/offer`, {
            method: 'POST',
            headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(fullOffer)
        });

        if (!response.ok) {
            throw new Error(`Failed to store offer on server (HTTP ${response.status})`);
        }

        logger.success('Offer stored on server — ready for sender to connect');
        return { roomId: this.roomId, secret: this.roomSecret };
    }

    /**
     * Wait for answer from server (for receiver)
     * Uses long-polling
     */
    async waitForAnswer() {
        logger.info('Waiting for sender to connect...');
        logger.debug('SIGNALING', 'Starting long-poll for answer', { roomId: this.roomId });

        while (true) {
            try {
                const response = await fetch(`/api/rooms/${this.roomId}/answer?wait=true`, {
                    headers: this.getAuthHeaders()
                });

                logger.debug('SIGNALING', 'Poll response', { status: response.status });

                if (response.status === 200) {
                    const answer = await response.json();
                    logger.info('Received answer from server');
                    logger.debug('SIGNALING', 'Answer received', {
                        type: answer.type,
                        sdpLength: answer.sdp?.length
                    });

                    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
                    this.remoteDescriptionSet = true;
                    logger.debug('SIGNALING', 'Remote description set');

                    // Process any pending ICE candidates
                    for (const candidate of this.pendingIceCandidates) {
                        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
                        logger.debug('ICE', 'Added pending remote candidate');
                    }
                    this.pendingIceCandidates = [];

                    // Fetch sender's ICE candidates and start polling for late arrivals
                    await this.fetchRemoteIceCandidates('answer');
                    this.startIceCandidatePolling('answer');

                    logger.success('Answer processed');
                    return;
                } else if (response.status === 204) {
                    // No answer yet, continue polling
                    logger.debug('SIGNALING', 'No answer yet, continuing poll');
                    continue;
                } else if (response.status === 404) {
                    throw new RoomGoneError();
                }
            } catch (e) {
                // RoomGoneError is terminal — stop polling and propagate
                if (e instanceof RoomGoneError) throw e;
                // TypeError means a network failure (fetch rejected); retry after backoff
                logger.warn('Polling error, retrying: ' + e.message);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    /**
     * Join a room and process offer (for sender).
     * Requires the room secret obtained from the QR code URL.
     * @param {string} roomId - The 6-character room ID
     * @param {string} secret - The room secret from URL hash fragment
     */
    async joinRoom(roomId, secret) {
        this.roomId = roomId;
        this.roomSecret = secret;
        this.isOfferer = false;

        // Step 1: Verify room exists and has an offer
        logger.info(`[Step 1/6] Checking room ${roomId} exists...`);
        const checkResponse = await fetch(`/api/rooms/${roomId}`, {
            headers: this.getAuthHeaders()
        });
        if (!checkResponse.ok) {
            if (checkResponse.status === 401) {
                throw new Error('Invalid room secret — the QR code may be corrupted or expired');
            }
            if (checkResponse.status === 404) {
                throw new Error('Room not found — it may have expired (rooms last 10 minutes)');
            }
            throw new Error(`Room check failed (HTTP ${checkResponse.status})`);
        }

        const roomInfo = await checkResponse.json();
        if (!roomInfo.hasOffer) {
            throw new Error('Room exists but the receiver has not finished setting up yet — try again in a moment');
        }
        logger.success('[Step 1/6] Room found and offer is ready');

        // Step 2: Fetch receiver's SDP offer
        logger.info('[Step 2/6] Fetching receiver\'s connection offer...');
        const offerResponse = await fetch(`/api/rooms/${roomId}/offer`, {
            headers: this.getAuthHeaders()
        });
        if (!offerResponse.ok) {
            throw new Error(`Failed to get offer from server (HTTP ${offerResponse.status})`);
        }
        const offer = await offerResponse.json();
        logger.success('[Step 2/6] Got offer from receiver');

        // Step 3: Create peer connection and set remote description
        logger.info('[Step 3/6] Setting up peer connection...');
        this.createPeerConnection();
        await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
        this.remoteDescriptionSet = true;

        // Step 4: Fetch receiver's trickle ICE candidates. Polling is deferred to after
        // step 6 so the connection timeout doesn't include answer creation time.
        // Note: the gap between this one-shot fetch and the deferred polling is harmless
        // because the receiver's candidates are already embedded in the SDP offer
        // (the receiver calls waitForICE() before storing its offer).
        logger.info('[Step 4/6] Fetching receiver\'s ICE candidates...');
        await this.fetchRemoteIceCandidates('offer');

        // Step 5: Create and send SDP answer
        logger.info('[Step 5/6] Creating connection answer...');
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        logger.info('[Step 5/6] Answer created, gathering ICE candidates...');

        await this.waitForICE();

        // Step 6: Store answer on server
        logger.info('[Step 6/6] Sending answer to signaling server...');
        const fullAnswer = {
            type: this.pc.localDescription.type,
            sdp: this.pc.localDescription.sdp
        };

        const answerResponse = await fetch(`/api/rooms/${roomId}/answer`, {
            method: 'POST',
            headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(fullAnswer)
        });

        if (!answerResponse.ok) {
            throw new Error(`Failed to store answer on server (HTTP ${answerResponse.status})`);
        }

        logger.success('[Step 6/6] Answer sent — establishing peer connection...');

        // Start candidate polling and connection timeout now that both sides have exchanged SDPs.
        // Previously this was at step 4, wasting ~6-7s of the timeout budget on local setup.
        this.startIceCandidatePolling('offer');
    }

    /**
     * Fetch remote ICE candidates from server and add any new ones.
     * Tracks how many candidates we've already processed to avoid duplicates.
     * @param {string} side - 'offer' or 'answer'
     */
    async fetchRemoteIceCandidates(side) {
        try {
            const response = await fetch(`/api/rooms/${this.roomId}/ice/${side}`, {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const data = await response.json();
                const allCandidates = data.candidates;
                // Only process candidates we haven't seen yet
                const newCandidates = allCandidates.slice(this._knownRemoteCandidateCount);
                if (newCandidates.length > 0) {
                    logger.debug('ICE', `Got ${newCandidates.length} new remote candidates (total: ${allCandidates.length})`);
                }
                this._knownRemoteCandidateCount = allCandidates.length;

                for (const candidate of newCandidates) {
                    if (this.remoteDescriptionSet) {
                        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
                        logger.info('Added remote ICE candidate');
                        logger.debug('ICE', 'Added remote candidate', {
                            candidateStr: candidate.candidate?.substring(0, 80)
                        });
                    } else {
                        this.pendingIceCandidates.push(candidate);
                        logger.debug('ICE', 'Queued remote candidate (remote desc not set yet)');
                    }
                }
            }
        } catch (e) {
            logger.warn('Failed to fetch ICE candidates: ' + e.message);
        }
    }

    /**
     * Start polling for new remote ICE candidates.
     * Trickle ICE means candidates arrive asynchronously — a single fetch may miss
     * late-arriving candidates (especially STUN srflx). Polling every 1s until the
     * connection is established ensures we pick them all up.
     * @param {string} side - 'offer' or 'answer' — the remote side to poll
     */
    startIceCandidatePolling(side) {
        this._icePollRemoteSide = side;
        logger.debug('ICE', `Starting ICE candidate polling (${side} side)`);

        this._icePollTimer = setInterval(async () => {
            // Stop polling once connected or failed
            if (!this.pc || this.pc.connectionState === 'connected' || this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') {
                this.stopIceCandidatePolling();
                return;
            }
            await this.fetchRemoteIceCandidates(side);
        }, 1000);

        // Start connection timeout — if WebRTC stays stuck in 'connecting' or
        // 'checking' (e.g. TURN server unreachable, bad credentials), this fires
        // after 10s to stop the infinite polling and surface a clear error.
        this._startConnectionTimeout();
    }

    /**
     * Stop ICE candidate polling and connection timeout.
     * Called when connection succeeds, fails, or times out.
     */
    stopIceCandidatePolling() {
        if (this._icePollTimer) {
            clearInterval(this._icePollTimer);
            this._icePollTimer = null;
            logger.debug('ICE', 'Stopped ICE candidate polling');
        }
        if (this._connectionTimeout) {
            clearTimeout(this._connectionTimeout);
            this._connectionTimeout = null;
        }
    }

    /**
     * Start a timeout that fires if WebRTC never reaches a terminal state.
     * Without this, a misconfigured TURN server (unreachable, bad credentials)
     * causes infinite polling with no user-visible error.
     */
    _startConnectionTimeout() {
        if (this._connectionTimeout) return; // already running
        this._connectionTimeout = setTimeout(() => {
            if (!this.pc) return;
            const state = this.pc.connectionState;
            const iceState = this.pc.iceConnectionState;
            // Only fire if still stuck in a non-terminal state
            if (state !== 'connected' && state !== 'failed' && state !== 'closed') {
                logger.error(`Connection timed out after ${this._CONNECTION_TIMEOUT_MS / 1000}s — WebRTC never connected`);
                logger.error(`Final states: connectionState=${state}, iceConnectionState=${iceState}`);
                logger.error('Likely causes: TURN server unreachable, bad TURN credentials, or firewall blocking UDP/TCP relay ports');
                this._logConnectionFailure();
                this.stopIceCandidatePolling();
                if (this.onDisconnected) this.onDisconnected();
            }
        }, this._CONNECTION_TIMEOUT_MS);
    }

    /**
     * Wait for ICE gathering to complete with timeout
     */
    waitForICE() {
        return new Promise((resolve) => {
            if (this.pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }

            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(timeout);
                this.pc.removeEventListener('icegatheringstatechange', onChange);
                resolve();
            };

            const onChange = () => {
                if (this.pc.iceGatheringState === 'complete') finish();
            };

            const timeout = setTimeout(() => {
                logger.warn('ICE gathering timeout, proceeding with available candidates');
                finish();
            }, 5000);

            this.pc.addEventListener('icegatheringstatechange', onChange);
        });
    }

    /**
     * Log detailed diagnostics when a connection fails.
     * Collects ICE candidate info, connection stats, and configuration to help
     * the user understand exactly what was tried and why it failed.
     */
    async _logConnectionFailure() {
        logger.error('=== CONNECTION FAILURE DIAGNOSTICS ===');
        logger.error(`ICE connection state: ${this.pc.iceConnectionState}`);
        logger.error(`ICE gathering state: ${this.pc.iceGatheringState}`);
        logger.error(`Signaling state: ${this.pc.signalingState}`);

        // Log configured ICE servers
        const config = this.pc.getConfiguration();
        const serverCount = config.iceServers?.length || 0;
        const hasStun = config.iceServers?.some(s => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
            return urls.some(u => u.startsWith('stun:'));
        });
        const hasTurn = config.iceServers?.some(s => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
            return urls.some(u => u.startsWith('turn:') || u.startsWith('turns:'));
        });
        logger.error(`ICE servers configured: ${serverCount} (STUN: ${hasStun ? 'yes' : 'NO'}, TURN: ${hasTurn ? 'yes' : 'NO'})`);

        if (!hasTurn) {
            logger.error('No TURN server configured — connection will fail if both peers are behind symmetric NATs');
        }

        // Gather candidate pair stats to show what was attempted
        try {
            const stats = await this.pc.getStats();
            let localCandidateTypes = [];
            let remoteCandidateTypes = [];
            let pairStates = [];

            stats.forEach(report => {
                if (report.type === 'local-candidate') {
                    localCandidateTypes.push(`${report.candidateType}/${report.protocol || '?'}/${report.address || '?'}:${report.port || '?'}`);
                }
                if (report.type === 'remote-candidate') {
                    remoteCandidateTypes.push(`${report.candidateType}/${report.protocol || '?'}/${report.address || '?'}:${report.port || '?'}`);
                }
                if (report.type === 'candidate-pair') {
                    pairStates.push(`${report.state} (nominated:${report.nominated})`);
                }
            });

            logger.error(`Local candidates gathered: ${localCandidateTypes.length > 0 ? localCandidateTypes.join(', ') : 'NONE'}`);
            logger.error(`Remote candidates received: ${remoteCandidateTypes.length > 0 ? remoteCandidateTypes.join(', ') : 'NONE'}`);
            logger.error(`Candidate pairs tried: ${pairStates.length > 0 ? pairStates.join(', ') : 'NONE'}`);

            if (localCandidateTypes.length === 0) {
                logger.error('No local candidates — STUN server may be unreachable or blocked by firewall');
            }
            if (remoteCandidateTypes.length === 0) {
                logger.error('No remote candidates — the other peer may have failed to gather candidates');
            }
        } catch (e) {
            logger.error('Could not gather stats: ' + e.message);
        }

        logger.error('=== END DIAGNOSTICS ===');
    }

    /**
     * Detect the connection type by examining the selected ICE candidate pair.
     * Uses getStats() API to find the active candidate pair and determine
     * if connection is direct (host/srflx/prflx) or relayed (TURN).
     */
    async detectConnectionType() {
        if (!this.pc) return;

        try {
            const stats = await this.pc.getStats();
            let selectedPair = null;

            // Find the selected candidate pair
            stats.forEach(report => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    // Prefer nominated pair if available
                    if (report.nominated || !selectedPair) {
                        selectedPair = report;
                    }
                }
            });

            if (!selectedPair) {
                logger.warn('Could not find selected candidate pair');
                return;
            }

            // Get the local and remote candidate details
            let localCandidate = null;
            let remoteCandidate = null;

            stats.forEach(report => {
                if (report.type === 'local-candidate' && report.id === selectedPair.localCandidateId) {
                    localCandidate = report;
                }
                if (report.type === 'remote-candidate' && report.id === selectedPair.remoteCandidateId) {
                    remoteCandidate = report;
                }
            });

            // Determine connection type based on candidate types:
            // - "host": direct local network connection
            // - "srflx": server reflexive (via STUN, but still P2P)
            // - "prflx": peer reflexive (discovered during connectivity checks, P2P)
            // - "relay": relayed through TURN server
            const localType = localCandidate?.candidateType || 'unknown';
            const remoteType = remoteCandidate?.candidateType || 'unknown';

            let connectionType;
            let connectionDetails;

            if (localType === 'relay' || remoteType === 'relay') {
                connectionType = 'relay';
                // Distinguish TURN (UDP/TCP) from TURNS (TLS) via relayProtocol
                const relayProtocol = localCandidate?.relayProtocol || remoteCandidate?.relayProtocol;
                if (relayProtocol === 'tls') {
                    connectionDetails = i18n.t('connection.relaySecureDetails');
                } else {
                    connectionDetails = i18n.t('connection.relayDetails');
                }
            } else if (localType === 'host' && remoteType === 'host') {
                connectionType = 'direct-local';
                connectionDetails = i18n.t('connection.directLocalDetails');
            } else {
                connectionType = 'direct-p2p';
                connectionDetails = i18n.t('connection.directP2PDetails');
            }

            logger.info(`Connection type: ${connectionDetails} (local: ${localType}, remote: ${remoteType})`);
            logger.debug('CONNECTION', 'Connection type detected', {
                connectionType,
                localType,
                remoteType,
                localAddress: localCandidate?.address,
                remoteAddress: remoteCandidate?.address
            });

            if (this.onConnectionTypeDetected) {
                this.onConnectionTypeDetected({
                    type: connectionType,
                    details: connectionDetails,
                    localType,
                    remoteType
                });
            }
        } catch (e) {
            logger.warn('Failed to detect connection type: ' + e.message);
        }
    }

    /**
     * Probe each configured ICE server for reachability (DEV mode only).
     * Creates a temporary RTCPeerConnection per server, triggers ICE gathering,
     * and checks whether the expected candidate type appears within a timeout.
     * Results are logged to help diagnose firewall/configuration issues.
     */
    async diagnoseIceServers() {
        if (!this._devMode) return;
        if (!this.iceServers || this.iceServers.length === 0) {
            logger.debug('DIAG', 'No ICE servers to diagnose');
            return;
        }

        logger.info('=== ICE SERVER REACHABILITY CHECK (DEV) ===');

        // Build a list of individual probes: one per URL
        const probes = [];
        for (const server of this.iceServers) {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            for (const url of urls) {
                probes.push({
                    url,
                    username: server.username,
                    credential: server.credential
                });
            }
        }

        const results = await Promise.all(probes.map(probe => this._probeIceServer(probe)));

        let allOk = true;
        for (const r of results) {
            if (r.reachable) {
                logger.success(`[DIAG] ${r.url} — reachable (got ${r.candidateType} candidate in ${r.elapsed}ms)`);
            } else {
                allOk = false;
                logger.error(`[DIAG] ${r.url} — UNREACHABLE (no candidate after ${r.elapsed}ms) — likely blocked by firewall or server is down`);
            }
        }

        if (allOk) {
            logger.success('=== All ICE servers reachable ===');
        } else {
            logger.warn('=== Some ICE servers unreachable — check firewall rules ===');
        }
    }

    /**
     * Probe a single ICE server URL by creating a temporary peer connection
     * and checking if the expected candidate type is gathered.
     * @param {Object} probe - {url, username, credential}
     * @returns {Promise<{url, reachable, candidateType, elapsed}>}
     */
    _probeIceServer(probe) {
        return new Promise((resolve) => {
            const TIMEOUT_MS = 5000;
            const start = performance.now();

            const iceServer = { urls: probe.url };
            if (probe.username) iceServer.username = probe.username;
            if (probe.credential) iceServer.credential = probe.credential;

            // For TURN/TURNS probes, force relay-only so we specifically test relay reachability
            const isTurn = probe.url.startsWith('turn:') || probe.url.startsWith('turns:');
            const pc = new RTCPeerConnection({
                iceServers: [iceServer],
                iceTransportPolicy: isTurn ? 'relay' : 'all'
            });

            let resolved = false;
            const expectedType = isTurn ? 'relay' : 'srflx';

            const done = (reachable, candidateType) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                pc.close();
                resolve({
                    url: probe.url,
                    reachable,
                    candidateType: candidateType || null,
                    elapsed: Math.round(performance.now() - start)
                });
            };

            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    const type = event.candidate.type;
                    if (type === expectedType || type === 'relay') {
                        done(true, type);
                    }
                }
            };

            // Also check gathering complete with no matching candidate
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete' && !resolved) {
                    done(false, null);
                }
            };

            const timer = setTimeout(() => done(false, null), TIMEOUT_MS);

            // Create a dummy data channel and offer to trigger ICE gathering
            pc.createDataChannel('probe');
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .catch(() => done(false, null));
        });
    }

    /**
     * Close the connection
     */
    close() {
        this.stopIceCandidatePolling();
        if (this._disconnectTimer) {
            clearTimeout(this._disconnectTimer);
            this._disconnectTimer = null;
        }
        if (this._fileAckTimeout) {
            clearTimeout(this._fileAckTimeout);
            this._fileAckTimeout = null;
        }
        if (this._fileAckReject) {
            this._fileAckReject(new Error('Connection closed before receiver acknowledged transfer'));
            this._fileAckResolve = null;
            this._fileAckReject = null;
        }
        // Clear any in-progress receive buffers
        this.receiveBuffer = [];
        this.receivedSize = 0;
        this.expectedSize = 0;
        this._lastLoggedDecile = -1;
        this.pendingIceCandidates = [];
        if (this.dataChannel) {
            this.dataChannel.close();
        }
        if (this.pc) {
            this.pc.close();
        }
        logger.info('Connection closed');
    }
}

window.WebSendRTC = WebSendRTC;
