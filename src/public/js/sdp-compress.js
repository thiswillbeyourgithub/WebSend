/**
 * SDP Compression module for WebSend
 * Compresses WebRTC SDP offers to fit in a QR code.
 *
 * Strategy:
 * 1. Extract only essential fields from SDP
 * 2. Use short keys and compact encoding
 * 3. Compress with built-in compression API if available
 * 4. Encode as base64 for QR code
 *
 * A full SDP offer is typically 2-3KB. A QR code can hold ~2KB in binary mode.
 * We need to compress aggressively to fit.
 */

const SDPCompress = {
    /**
     * Extract essential data from SDP and ICE candidates
     * @param {RTCSessionDescription} description - SDP offer/answer
     * @param {RTCIceCandidate[]} candidates - Gathered ICE candidates
     * @returns {Object} Compact representation
     */
    extractEssentials(description, candidates) {
        const sdp = description.sdp;
        const lines = sdp.split('\r\n');

        // Extract fingerprint (for DTLS)
        let fingerprint = '';
        let iceUfrag = '';
        let icePwd = '';

        // Parse only the 3 fields needed to reconstruct a working SDP:
        // - fingerprint: identifies the DTLS certificate (ensures we connect to the right peer)
        // - ice-ufrag/ice-pwd: ICE credentials for connectivity checks
        for (const line of lines) {
            if (line.startsWith('a=fingerprint:')) {
                fingerprint = line.substring(14); // "sha-256 XX:XX:XX..."
            } else if (line.startsWith('a=ice-ufrag:')) {
                iceUfrag = line.substring(12);
            } else if (line.startsWith('a=ice-pwd:')) {
                icePwd = line.substring(10);
            }
        }

        // Extract best ICE candidates (prefer host/srflx over relay for initial attempt)
        // Include relay as fallback
        const compactCandidates = candidates
            .filter(c => c && c.candidate)
            .map(c => {
                const parts = c.candidate.split(' ');
                // candidate:foundation component protocol priority ip port type ...
                // Use very short keys and compact values
                return {
                    i: parts[4], // ip
                    o: parseInt(parts[5]), // port
                    // Single char for type: h=host, s=srflx, r=relay
                    t: parts[7][0],
                    // Single char for protocol: u=udp, t=tcp
                    p: parts[2][0]
                };
            })
            // Prioritize: host first, then srflx, then relay
            // Keep max 3 candidates to fit in QR (aggressive to ensure fit)
            .sort((a, b) => {
                const order = { h: 0, s: 1, r: 2 };
                return (order[a.t] || 3) - (order[b.t] || 3);
            })
            .slice(0, 3);

        // Compact fingerprint by removing colons (saves 31 chars)
        const compactFp = fingerprint.replace('sha-256 ', '').replace(/:/g, '');

        return {
            // Type: 'o' for offer, 'a' for answer
            y: description.type === 'offer' ? 'o' : 'a',
            // Fingerprint without colons
            f: compactFp,
            // ICE credentials
            u: iceUfrag,
            w: icePwd,
            // Candidates
            c: compactCandidates
        };
    },

    /**
     * Compress the essential data into a string suitable for QR code
     * @param {Object} essentials - Output from extractEssentials
     * @returns {Promise<string>} Compressed base64 string
     */
    async compress(essentials) {
        const json = JSON.stringify(essentials);
        logger.info(`SDP JSON size: ${json.length} bytes`);

        // Try the Compression Streams API (available in Chrome 80+, Firefox 113+, Safari 16.4+).
        // Uses DEFLATE which typically achieves 40-60% compression on SDP JSON.
        if (typeof CompressionStream !== 'undefined') {
            try {
                const encoder = new TextEncoder();
                const data = encoder.encode(json);

                const cs = new CompressionStream('deflate');
                const writer = cs.writable.getWriter();
                writer.write(data);
                writer.close();

                const reader = cs.readable.getReader();
                const chunks = [];
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                }

                const compressed = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
                let offset = 0;
                for (const chunk of chunks) {
                    compressed.set(chunk, offset);
                    offset += chunk.length;
                }

                // Prefix with 'Z' to indicate deflate-compressed (vs 'J' for raw JSON)
                const base64 = 'Z' + btoa(String.fromCharCode(...compressed));
                logger.info(`Compressed SDP: ${base64.length} chars`);
                return base64;
            } catch (e) {
                logger.warn('Compression failed, using uncompressed: ' + e.message);
            }
        }

        // Fallback: just base64 encode the JSON, prefix with 'J'
        const base64 = 'J' + btoa(json);
        logger.info(`Uncompressed SDP: ${base64.length} chars`);
        return base64;
    },

    /**
     * Decompress a QR code payload back into essentials object
     * @param {string} compressed - Compressed string from QR code
     * @returns {Promise<Object>} Essentials object
     */
    async decompress(compressed) {
        if (compressed.startsWith('Z')) {
            // Compressed with deflate
            const base64 = compressed.substring(1);
            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            const ds = new DecompressionStream('deflate');
            const writer = ds.writable.getWriter();
            writer.write(bytes);
            writer.close();

            const reader = ds.readable.getReader();
            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }

            const decompressed = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
            let offset = 0;
            for (const chunk of chunks) {
                decompressed.set(chunk, offset);
                offset += chunk.length;
            }

            const decoder = new TextDecoder();
            const json = decoder.decode(decompressed);
            return JSON.parse(json);
        } else if (compressed.startsWith('J')) {
            // Uncompressed JSON
            const json = atob(compressed.substring(1));
            return JSON.parse(json);
        } else {
            throw new Error('Unknown compression format');
        }
    },

    /**
     * Reconstruct a full SDP from the essentials
     * This creates a minimal but valid SDP for WebRTC
     * @param {Object} essentials - Decompressed essentials
     * @returns {RTCSessionDescription}
     */
    reconstructSDP(essentials) {
        // ── Hidden assumptions in this reconstruction ──────────────────────────
        // 1. Data-channel only: no audio/video m-sections. Adding media to the
        //    session would require additional m-sections not generated here.
        // 2. SCTP port 5000 and max-message-size 262144 are hard-coded. These
        //    match Chrome/Firefox/Safari defaults as of 2024; if browsers change
        //    their defaults the reconstructed SDP would still work for existing
        //    peers but not advertise updated capabilities.
        // 3. `a=setup:actpass` (offerer) / `a=setup:active` (answerer) follows
        //    RFC 5763 §5; swapping these breaks the DTLS handshake.
        // 4. The ICE candidate priorities (2130706431 / 1694498815 / 16777215)
        //    are synthetic approximations of the values Chrome emits.  They do
        //    not affect connectivity but will differ from a real offer's values.
        // 5. extmap, rtcp-mux, and codec negotiation lines are intentionally
        //    omitted — they are irrelevant for data-channel-only sessions.
        // ──────────────────────────────────────────────────────────────────────

        // Expand fingerprint by re-inserting colons between hex pairs (AA -> AA:BB:...)
        const fp = essentials.f.match(/.{2}/g).join(':');

        // Build a minimal but valid SDP for a WebRTC data channel.
        // Only includes the fields required for DTLS-SRTP + SCTP:
        // - Session metadata (v, o, s, t lines)
        // - BUNDLE group for multiplexing
        // - Single media section for the data channel (m=application)
        // - ICE credentials and DTLS fingerprint for security
        // - SCTP parameters for data channel
        const sdp = [
            'v=0',                                                      // SDP version
            'o=- ' + Date.now() + ' 1 IN IP4 0.0.0.0',               // Session origin (timestamp as ID)
            's=-',                                                      // Session name (unused)
            't=0 0',                                                    // Timing (permanent session)
            'a=group:BUNDLE 0',                                         // Bundle all media into one transport
            'a=msid-semantic: WMS',                                     // Media stream ID semantic
            'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',       // Data channel media section
            'c=IN IP4 0.0.0.0',                                        // Connection info (placeholder)
            'a=ice-ufrag:' + essentials.u,                             // ICE username fragment
            'a=ice-pwd:' + essentials.w,                               // ICE password
            'a=ice-options:trickle',                                    // Allow trickle ICE
            'a=fingerprint:sha-256 ' + fp,                             // DTLS certificate fingerprint
            'a=setup:' + (essentials.y === 'o' ? 'actpass' : 'active'), // DTLS role (offerer=actpass, answerer=active)
            'a=mid:0',                                                  // Media ID for BUNDLE
            'a=sctp-port:5000',                                        // SCTP port for data channel
            'a=max-message-size:262144'                                // Max SCTP message size (256KB)
        ];

        // Expand single-char type/protocol codes back to full ICE candidate values
        const typeMap = { h: 'host', s: 'srflx', r: 'relay' };
        const protoMap = { u: 'udp', t: 'tcp' };

        // Reconstruct ICE candidate lines with synthetic priorities.
        // Priority values are approximate but follow the standard ordering:
        // host > srflx > relay (higher priority = preferred)
        for (const c of essentials.c) {
            const type = typeMap[c.t] || 'host';
            const proto = protoMap[c.p] || 'udp';
            const priority = type === 'host' ? 2130706431 : type === 'srflx' ? 1694498815 : 16777215;
            sdp.push(`a=candidate:1 1 ${proto} ${priority} ${c.i} ${c.o} typ ${type}`);
        }

        const sdpString = sdp.join('\r\n') + '\r\n';

        return new RTCSessionDescription({
            type: essentials.y === 'o' ? 'offer' : 'answer',
            sdp: sdpString
        });
    }
};

window.SDPCompress = SDPCompress;
