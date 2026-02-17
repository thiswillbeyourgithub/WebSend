/**
 * WebRTC module for ImageSecureSend
 * Handles peer-to-peer connection establishment and data channel communication.
 * Uses server-based signaling for SDP exchange.
 */

class ImageSecureSendRTC {
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
        this.currentFileMetadata = null;

        // ICE candidate handling
        this.pendingIceCandidates = [];
        this.remoteDescriptionSet = false;
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
            // Enable DEV mode in logger if server has it enabled
            if (config.dev) {
                logger.setDevMode(true);
            }
            logger.success(`Got ${this.iceServers.length} ICE servers`);
            logger.debug('CONFIG', 'ICE servers loaded', { servers: this.iceServers });
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
            iceServers: this.iceServers
        });

        // Track ICE candidates and send to server
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
            logger.info(`Connection state: ${this.pc.connectionState}`);
            logger.debug('CONNECTION', 'Peer connection state changed', {
                connectionState: this.pc.connectionState,
                iceConnectionState: this.pc.iceConnectionState,
                iceGatheringState: this.pc.iceGatheringState,
                signalingState: this.pc.signalingState
            });
            if (this.onStateChange) {
                this.onStateChange(this.pc.connectionState);
            }
            if (this.pc.connectionState === 'connected') {
                logger.success('Peer connection established!');
                if (this.onConnected) this.onConnected();
                // Detect connection type after connection is established
                this.detectConnectionType();
            } else if (this.pc.connectionState === 'disconnected' || this.pc.connectionState === 'failed') {
                logger.error('Peer connection lost');
                if (this.onDisconnected) this.onDisconnected();
            }
        };

        this.pc.oniceconnectionstatechange = () => {
            logger.info(`ICE connection state: ${this.pc.iceConnectionState}`);
            logger.debug('ICE', 'ICE connection state changed', {
                iceConnectionState: this.pc.iceConnectionState,
                connectionState: this.pc.connectionState
            });
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
                logger.info(`Received message type: ${msg.type}`);

                if (msg.type === 'file-start') {
                    // File-start now only contains encrypted size (padded).
                    // Metadata is encrypted inside the payload.
                    this.receiveBuffer = [];
                    this.receivedSize = 0;
                    this.expectedSize = msg.size;
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
            const percent = Math.round((this.receivedSize / this.expectedSize) * 100);
            if (percent % 10 === 0) {
                logger.info(`Receiving: ${percent}%`);
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
        this.dataChannel.send(JSON.stringify(message));
        return true;
    }

    /**
     * Send a file (binary) over the data channel.
     * The data should already be encrypted with metadata bundled via
     * ImageSecureSendCrypto.encryptWithMetadata() - this function only handles
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

        const CHUNK_SIZE = 16384; // 16KB chunks
        const totalSize = encryptedData.byteLength;
        let offset = 0;

        // File-start message contains only the encrypted size (which is padded).
        // No plaintext metadata is revealed - name, type, and original size
        // are encrypted inside the payload.
        this.sendMessage({
            type: 'file-start',
            size: totalSize
        });

        logger.info(`Sending encrypted file (${totalSize} bytes, padded)`);

        while (offset < totalSize) {
            while (this.dataChannel.bufferedAmount > 1024 * 1024) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            const chunk = encryptedData.slice(offset, offset + CHUNK_SIZE);
            this.dataChannel.send(chunk);
            offset += chunk.byteLength;

            const percent = Math.round((offset / totalSize) * 100);
            if (onProgress) onProgress(percent);
        }

        this.sendMessage({ type: 'file-end' });
        logger.success('Encrypted file sent successfully');
        return true;
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
        logger.debug('SIGNALING', 'Creating peer connection as offerer');
        this.createPeerConnection();

        // Create data channel
        const dc = this.pc.createDataChannel('imagesecurescan', { ordered: true });
        this.setupDataChannel(dc);

        // Create offer
        logger.debug('SIGNALING', 'Creating SDP offer...');
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        logger.info('Created offer, gathering ICE candidates...');
        logger.debug('SIGNALING', 'Local description set', {
            type: offer.type,
            sdpLength: offer.sdp?.length
        });

        // Wait for ICE gathering
        await this.waitForICE();

        // Store offer on server (with gathered candidates in the SDP)
        const fullOffer = {
            type: this.pc.localDescription.type,
            sdp: this.pc.localDescription.sdp
        };

        logger.debug('SIGNALING', 'Storing offer on server', {
            sdpLength: fullOffer.sdp?.length
        });
        await fetch(`/api/rooms/${this.roomId}/offer`, {
            method: 'POST',
            headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(fullOffer)
        });

        logger.success('Offer stored on server');
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

                    // Also fetch and add sender's ICE candidates
                    await this.fetchRemoteIceCandidates('answer');

                    logger.success('Answer processed');
                    return;
                } else if (response.status === 204) {
                    // No answer yet, continue polling
                    logger.debug('SIGNALING', 'No answer yet, continuing poll');
                    continue;
                } else if (response.status === 404) {
                    throw new Error('Room expired or not found');
                }
            } catch (e) {
                if (e.message.includes('Room')) throw e;
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
        logger.info(`Joining room: ${roomId}`);
        logger.debug('SIGNALING', 'Joining room as answerer', { roomId });

        // Check room exists and has offer (requires secret)
        const checkResponse = await fetch(`/api/rooms/${roomId}`, {
            headers: this.getAuthHeaders()
        });
        logger.debug('SIGNALING', 'Room check response', { status: checkResponse.status });
        if (!checkResponse.ok) {
            if (checkResponse.status === 401) {
                throw new Error('Invalid room secret - QR code may be corrupted');
            }
            throw new Error('Room not found or expired');
        }

        const roomInfo = await checkResponse.json();
        logger.debug('SIGNALING', 'Room info', roomInfo);
        if (!roomInfo.hasOffer) {
            throw new Error('Room exists but offer not ready yet');
        }

        // Fetch offer
        const offerResponse = await fetch(`/api/rooms/${roomId}/offer`, {
            headers: this.getAuthHeaders()
        });
        if (!offerResponse.ok) {
            throw new Error('Failed to get offer');
        }
        const offer = await offerResponse.json();
        logger.info('Got offer from server');
        logger.debug('SIGNALING', 'Offer received', {
            type: offer.type,
            sdpLength: offer.sdp?.length
        });

        // Process offer
        logger.debug('SIGNALING', 'Creating peer connection as answerer');
        this.createPeerConnection();
        await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
        this.remoteDescriptionSet = true;
        logger.debug('SIGNALING', 'Remote description set from offer');

        // Fetch and add receiver's ICE candidates
        await this.fetchRemoteIceCandidates('offer');

        // Create and store answer
        logger.debug('SIGNALING', 'Creating SDP answer...');
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        logger.info('Created answer, gathering ICE candidates...');
        logger.debug('SIGNALING', 'Local description set', {
            type: answer.type,
            sdpLength: answer.sdp?.length
        });

        await this.waitForICE();

        // Store answer on server
        const fullAnswer = {
            type: this.pc.localDescription.type,
            sdp: this.pc.localDescription.sdp
        };

        logger.debug('SIGNALING', 'Storing answer on server', {
            sdpLength: fullAnswer.sdp?.length
        });
        await fetch(`/api/rooms/${roomId}/answer`, {
            method: 'POST',
            headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(fullAnswer)
        });

        logger.success('Answer stored on server, waiting for connection...');
    }

    /**
     * Fetch remote ICE candidates from server
     * @param {string} side - 'offer' or 'answer'
     */
    async fetchRemoteIceCandidates(side) {
        logger.debug('ICE', `Fetching remote ICE candidates (${side} side)`);
        try {
            const response = await fetch(`/api/rooms/${this.roomId}/ice/${side}`, {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const data = await response.json();
                logger.debug('ICE', `Received ${data.candidates.length} remote candidates`);
                for (const candidate of data.candidates) {
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
     * Wait for ICE gathering to complete with timeout
     */
    waitForICE() {
        return new Promise((resolve) => {
            if (this.pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                logger.warn('ICE gathering timeout, proceeding with available candidates');
                resolve();
            }, 5000);

            this.pc.onicegatheringstatechange = () => {
                if (this.pc.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
        });
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
                connectionDetails = 'Relayed via TURN server';
            } else if (localType === 'host' && remoteType === 'host') {
                connectionType = 'direct-local';
                connectionDetails = 'Direct (local network)';
            } else {
                connectionType = 'direct-p2p';
                connectionDetails = 'Direct P2P (via STUN)';
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
     * Close the connection
     */
    close() {
        if (this.dataChannel) {
            this.dataChannel.close();
        }
        if (this.pc) {
            this.pc.close();
        }
        logger.info('Connection closed');
    }
}

window.ImageSecureSendRTC = ImageSecureSendRTC;
