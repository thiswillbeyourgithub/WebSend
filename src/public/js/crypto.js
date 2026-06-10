/**
 * Crypto module for WebSend
 *
 * Implements ECDH (Elliptic Curve Diffie-Hellman) key exchange with AES-GCM encryption.
 * This provides forward secrecy: if a private key is compromised later, past sessions
 * remain secure because each session uses fresh ephemeral keys.
 *
 * Protocol:
 * 1. Receiver generates ECDH key pair, sends public key to sender
 * 2. Sender generates ECDH key pair, derives shared secret, sends their public key
 * 3. Receiver derives same shared secret from sender's public key
 * 4. Both use shared secret to derive AES-256 key via HKDF
 * 5. Photos encrypted with AES-GCM using derived key
 *
 * Uses Web Crypto API for all cryptographic operations.
 */

const WebSendCrypto = {
    /**
     * Generate an ECDH key pair using P-256 curve (128-bit security level).
     * P-256 is widely supported and recommended by NIST.
     * @returns {Promise<{publicKey: CryptoKey, privateKey: CryptoKey}>}
     */
    async generateKeyPair() {
        logger.info('Generating ECDH key pair (P-256)...');

        const keyPair = await crypto.subtle.generateKey(
            {
                name: 'ECDH',
                namedCurve: 'P-256'
            },
            true, // extractable - needed to export public key
            ['deriveBits']
        );

        logger.success('ECDH key pair generated');
        return keyPair;
    },

    /**
     * Export public key to base64 format for transmission.
     * Uses raw format for ECDH public keys (compact 65-byte representation).
     * @param {CryptoKey} publicKey - The ECDH public key to export
     * @returns {Promise<string>} Base64-encoded public key
     */
    async exportPublicKey(publicKey) {
        const exported = await crypto.subtle.exportKey('raw', publicKey);
        const base64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
        logger.info(`Public key exported (${base64.length} chars)`);
        return base64;
    },

    /**
     * Import a public key from base64 format.
     * @param {string} base64Key - Base64-encoded ECDH public key
     * @returns {Promise<CryptoKey>}
     */
    async importPublicKey(base64Key) {
        logger.info('Importing ECDH public key...');
        const binaryString = atob(base64Key);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const publicKey = await crypto.subtle.importKey(
            'raw',
            bytes,
            {
                name: 'ECDH',
                namedCurve: 'P-256'
            },
            true,
            [] // ECDH public keys don't have usages, they're used in deriveBits
        );

        logger.success('ECDH public key imported');
        return publicKey;
    },

    /**
     * Derive the session key material from our private key and their public key.
     * Uses ECDH to compute the shared secret, then HKDF for all derived keys.
     *
     * Returns a frozen handle exposing:
     * - sharedKey: the session-wide AES-GCM key (control payloads, v1 format)
     * - deriveFileKey(saltBytes): a fresh per-file AES-GCM subkey for the v2
     *   chunked segment format. Re-deriving with a new random salt is how a
     *   transfer re-keys on rewind/resume, guaranteeing a (key, nonce) pair
     *   is never reused with different plaintext.
     *
     * The HKDF base key stays captured in the closure (non-extractable, never
     * exposed), so a leaked file key cannot reveal the session secret.
     *
     * @param {CryptoKey} privateKey - Our ECDH private key
     * @param {CryptoKey} theirPublicKey - Their ECDH public key
     * @returns {Promise<{sharedKey: CryptoKey, deriveFileKey: function(Uint8Array): Promise<CryptoKey>}>}
     */
    async deriveSessionKeys(privateKey, theirPublicKey) {
        logger.info('Deriving shared secret via ECDH...');

        // Perform ECDH key agreement to get shared secret (256 bits for P-256)
        const sharedSecret = await crypto.subtle.deriveBits(
            {
                name: 'ECDH',
                public: theirPublicKey
            },
            privateKey,
            256 // bits
        );

        // Use HKDF to derive AES keys from the shared secret.
        // HKDF provides proper key derivation with domain separation.
        const hkdfKey = await crypto.subtle.importKey(
            'raw',
            sharedSecret,
            'HKDF',
            false,
            ['deriveKey']
        );

        const sharedKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                // Salt provides randomness; using fixed value is acceptable for ECDH
                // since the shared secret itself is random per session
                salt: new TextEncoder().encode('WebSend-v1'),
                // Info provides domain separation
                info: new TextEncoder().encode('AES-GCM-256-key')
            },
            hkdfKey,
            {
                name: 'AES-GCM',
                length: 256
            },
            false, // not extractable
            ['encrypt', 'decrypt']
        );

        const fileKeyInfo = new TextEncoder().encode(this.SEGMENT_KDF_INFO);

        logger.success('Shared AES key derived');
        return Object.freeze({
            sharedKey,
            deriveFileKey(saltBytes) {
                // ArrayBuffer.isView is realm-agnostic, unlike instanceof
                if (!ArrayBuffer.isView(saltBytes) || saltBytes.byteLength !== 16) {
                    throw new Error('File salt must be 16 bytes');
                }
                return crypto.subtle.deriveKey(
                    {
                        name: 'HKDF',
                        hash: 'SHA-256',
                        salt: saltBytes,
                        info: fileKeyInfo
                    },
                    hkdfKey,
                    {
                        name: 'AES-GCM',
                        length: 256
                    },
                    false, // not extractable
                    ['encrypt', 'decrypt']
                );
            }
        });
    },

    /**
     * Derive only the session-wide AES-GCM key (legacy entry point; prefer
     * deriveSessionKeys which also exposes per-file subkey derivation).
     * @param {CryptoKey} privateKey - Our ECDH private key
     * @param {CryptoKey} theirPublicKey - Their ECDH public key
     * @returns {Promise<CryptoKey>} AES-GCM key derived from shared secret
     */
    async deriveSharedKey(privateKey, theirPublicKey) {
        return (await this.deriveSessionKeys(privateKey, theirPublicKey)).sharedKey;
    },

    /**
     * Compute SHA-256 fingerprint of a single public key.
     *
     * This is NOT the user-facing verification code any more (see
     * getCombinedFingerprint for that). It is kept for the reconnect
     * peer-identity check: caching one fingerprint per peer key lets the
     * reconnect path detect a peer swap without re-running the full
     * verification ceremony.
     *
     * Fixed at 16 hex chars (64 bits). This is the recognised floor for
     * verbal-comparison fingerprints (Signal uses 60 decimal digits, OTR
     * uses 40 hex / 160 bits). The threat is a signaling-MITM grinding ECDH
     * keys until the fingerprint they want appears, which is a second-preimage
     * search against any *one* session. That search cost is independent of
     * how many rooms are live, so shortening the code under low load (which
     * an earlier "adaptive" version did, going as low as 12 bits) does not
     * reduce attacker effort, it just makes the attack feasible in seconds
     * on a laptop (~10^6 ECDH+SHA-256 ops/sec). Do NOT reintroduce adaptive
     * sizing.
     *
     * @param {CryptoKey} publicKey - The public key to fingerprint
     * @returns {Promise<string>} 16-hex-char fingerprint grouped as XXXX-XXXX-XXXX-XXXX
     */
    async getKeyFingerprint(publicKey) {
        const HEX_LEN = 16; // 64 bits, see doc above. Do not lower.

        const exported = await crypto.subtle.exportKey('raw', publicKey);
        const hash = await crypto.subtle.digest('SHA-256', exported);
        const hashArray = new Uint8Array(hash);
        const bytesNeeded = HEX_LEN / 2;
        const hexChars = Array.from(hashArray.slice(0, bytesNeeded))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase();
        // Group in chunks of 4 with dashes for readability (XXXX-XXXX-XXXX-XXXX)
        const groups = [];
        for (let i = 0; i < hexChars.length; i += 4) {
            groups.push(hexChars.slice(i, i + 4));
        }
        return groups.join('-');
    },

    /**
     * Lexicographic comparison of two byte arrays. Returns <0, 0, or >0.
     * Used to put the two public keys in a canonical order so both peers
     * hash the same byte sequence regardless of who is sender or receiver.
     */
    _compareBytes(a, b) {
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            if (a[i] !== b[i]) return a[i] - b[i];
        }
        return a.length - b.length;
    },

    /**
     * Compute a single combined verification code from BOTH public keys.
     *
     * Unlike getKeyFingerprint (one fingerprint per key), this derives ONE
     * code that is identical on both devices. The user only has to check
     * that the two screens show the same code, instead of cross-referencing
     * two separate fingerprints in swapped roles (which testers found
     * confusing). The two raw public keys are sorted into a canonical order
     * before hashing so both peers compute the same value regardless of
     * argument order.
     *
     * 24 hex chars (96 bits). This is a single comparison rather than the
     * two 64-bit comparisons of the previous per-key scheme, so the length
     * is raised to 96 bits to keep the work factor (a 2^96 second-preimage
     * grind to make the two screens agree) comfortably above the old design.
     * The relevant attack is a signaling-MITM grinding ECDH keys until the
     * combined code on both sides matches; that cost is independent of how
     * many rooms are live, so do NOT shorten this or make it adaptive.
     *
     * @param {CryptoKey} pubKeyA - One party's ECDH public key
     * @param {CryptoKey} pubKeyB - The other party's ECDH public key
     * @returns {Promise<string>} 24-hex-char code grouped as XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
     */
    async getCombinedFingerprint(pubKeyA, pubKeyB) {
        const HEX_LEN = 24; // 96 bits, see doc above. Do not lower.

        const rawA = new Uint8Array(await crypto.subtle.exportKey('raw', pubKeyA));
        const rawB = new Uint8Array(await crypto.subtle.exportKey('raw', pubKeyB));

        // Canonical order so the code is identical on both peers.
        const [first, second] = this._compareBytes(rawA, rawB) <= 0
            ? [rawA, rawB]
            : [rawB, rawA];
        const combined = new Uint8Array(first.length + second.length);
        combined.set(first, 0);
        combined.set(second, first.length);

        const hash = await crypto.subtle.digest('SHA-256', combined);
        const hashArray = new Uint8Array(hash);
        const hexChars = Array.from(hashArray.slice(0, HEX_LEN / 2))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase();
        // Group in chunks of 4 with dashes (XXXX-XXXX-XXXX-XXXX-XXXX-XXXX)
        const groups = [];
        for (let i = 0; i < hexChars.length; i += 4) {
            groups.push(hexChars.slice(i, i + 4));
        }
        return groups.join('-');
    },

    /**
     * Encrypt data using AES-GCM with the shared key.
     * Each encryption uses a fresh random IV.
     *
     * @param {ArrayBuffer} data - Data to encrypt
     * @param {CryptoKey} sharedKey - AES key derived from ECDH
     * @returns {Promise<ArrayBuffer>} IV + encrypted data
     */
    async encrypt(data, sharedKey) {
        logger.info(`Encrypting ${data.byteLength} bytes with AES-GCM...`);

        // Generate random IV (12 bytes for GCM)
        const iv = crypto.getRandomValues(new Uint8Array(12));

        // Encrypt data with AES-GCM
        const encryptedData = await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: iv
            },
            sharedKey,
            data
        );

        // Package: [12 bytes IV][encrypted data with auth tag]
        const result = new Uint8Array(12 + encryptedData.byteLength);
        result.set(iv, 0);
        result.set(new Uint8Array(encryptedData), 12);

        logger.success(`Encrypted to ${result.byteLength} bytes`);
        return result.buffer;
    },

    /**
     * Decrypt data using AES-GCM with the shared key.
     * @param {ArrayBuffer} encryptedPackage - IV + encrypted data
     * @param {CryptoKey} sharedKey - AES key derived from ECDH
     * @returns {Promise<ArrayBuffer>} Decrypted data
     */
    async decrypt(encryptedPackage, sharedKey) {
        const data = new Uint8Array(encryptedPackage);
        logger.info(`Decrypting ${data.byteLength} bytes with AES-GCM...`);

        // Extract IV (first 12 bytes)
        const iv = data.slice(0, 12);

        // Extract encrypted data
        const encryptedData = data.slice(12);

        // Decrypt data with AES-GCM
        const decryptedData = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: iv
            },
            sharedKey,
            encryptedData
        );

        logger.success(`Decrypted to ${decryptedData.byteLength} bytes`);
        return decryptedData;
    },

    // ============ Chunked AEAD segments (v2, STREAM construction) ============
    //
    // The v2 file format encrypts a file as independent AES-GCM segments
    // instead of one whole-file message, so each segment is individually
    // authenticated on arrival (the transport never has to be trusted for
    // integrity) and a corrupted or lost segment costs one segment, not the
    // file. Each segment is sealed under a per-file subkey from
    // deriveSessionKeys().deriveFileKey(fileSalt) with a deterministic
    // counter nonce that is never transmitted:
    //
    //   nonce (12 bytes) = 7x00 || 4-byte big-endian seq || 1-byte final flag
    //
    // The seq in the nonce makes reordering and duplication fail
    // authentication; the final flag makes truncation fail authentication
    // (the last segment only opens when the receiver knows it is last).
    // Segment plaintext layout (all integers big-endian in v2):
    //
    //   [1B flags][4B dataLen][data][random padding]
    //
    // flags bit0 = data is gzipped. Padding appears only where the caller
    // asks for it (metadata record, final data segment).

    /** Segment plaintext flags */
    SEGMENT_FLAG_GZIP: 0x01,
    /** Bytes of [flags][dataLen] before the data in a segment plaintext */
    SEGMENT_HEADER_BYTES: 5,
    /** HKDF info string for per-file subkeys (domain-separated from the session key) */
    SEGMENT_KDF_INFO: 'WebSend-segment-v2',

    /**
     * Build the deterministic AES-GCM nonce for a segment.
     * @param {number} seq - Record sequence number (0 = metadata record)
     * @param {boolean} isFinal - True only for the last record of the file
     * @returns {Uint8Array} 12-byte nonce
     */
    buildSegmentNonce(seq, isFinal) {
        if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
            throw new Error('Invalid segment seq');
        }
        const nonce = new Uint8Array(12);
        new DataView(nonce.buffer).setUint32(7, seq, false); // big-endian
        nonce[11] = isFinal ? 1 : 0;
        return nonce;
    },

    /**
     * Seal one segment: optionally gzip the data, frame it as
     * [flags][dataLen][data][padding], and AES-GCM encrypt under the
     * per-file key with the deterministic nonce for (seq, isFinal).
     *
     * @param {CryptoKey} fileKey - From deriveSessionKeys().deriveFileKey(salt)
     * @param {number} seq - Record sequence number
     * @param {boolean} isFinal - True only for the last record of the file
     * @param {Uint8Array|ArrayBuffer} data - Segment payload
     * @param {Object} [opts]
     * @param {boolean} [opts.tryGzip] - Compress when it shrinks the data
     * @param {number} [opts.padToSize] - Pad the plaintext (header + data +
     *   padding) up to this many bytes with random bytes; ignored when the
     *   data already reaches it
     * @returns {Promise<ArrayBuffer>} Ciphertext including the 16-byte tag
     */
    async sealSegment(fileKey, seq, isFinal, data, opts = {}) {
        const raw = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
        let stored = raw;
        let flags = 0;
        if (opts.tryGzip) {
            const compressed = await this._maybeGzip(raw);
            if (compressed) {
                stored = new Uint8Array(compressed);
                flags |= this.SEGMENT_FLAG_GZIP;
            }
        }

        const minSize = this.SEGMENT_HEADER_BYTES + stored.length;
        const totalSize = Math.max(minSize, opts.padToSize || 0);
        // Random-fill when padding so the padding bytes are indistinguishable
        // from data; an unpadded segment is fully overwritten anyway.
        const plain = totalSize > minSize
            ? this.getRandomBytes(totalSize)
            : new Uint8Array(totalSize);
        plain[0] = flags;
        new DataView(plain.buffer).setUint32(1, stored.length, false);
        plain.set(stored, this.SEGMENT_HEADER_BYTES);

        return crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: this.buildSegmentNonce(seq, isFinal) },
            fileKey,
            plain
        );
    },

    /**
     * Open one sealed segment. Throws when authentication fails, which is
     * also how reordering (wrong seq), truncation (wrong final flag), and
     * any bit corruption surface. Strips padding and undoes gzip.
     *
     * @param {CryptoKey} fileKey - Per-file key the segment was sealed with
     * @param {number} seq - Expected record sequence number
     * @param {boolean} isFinal - Whether this must be the last record
     * @param {ArrayBuffer|Uint8Array} ciphertext - Output of sealSegment
     * @returns {Promise<ArrayBuffer>} The original segment payload
     */
    async openSegment(fileKey, seq, isFinal, ciphertext) {
        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: this.buildSegmentNonce(seq, isFinal) },
            fileKey,
            ciphertext
        );
        const plain = new Uint8Array(plainBuf);
        if (plain.length < this.SEGMENT_HEADER_BYTES) {
            throw new Error('Segment plaintext too short');
        }
        const flags = plain[0];
        const dataLen = new DataView(plainBuf).getUint32(1, false);
        if (this.SEGMENT_HEADER_BYTES + dataLen > plain.length) {
            throw new Error('Invalid segment data length');
        }
        // slice() copies, so .buffer is exactly dataLen bytes
        const stored = plain.slice(this.SEGMENT_HEADER_BYTES, this.SEGMENT_HEADER_BYTES + dataLen);
        if (flags & this.SEGMENT_FLAG_GZIP) {
            return this._gunzip(stored.buffer);
        }
        return stored.buffer;
    },

    // ============ Hashing ============

    /**
     * Compute SHA-256 hash of an ArrayBuffer and return it as a hex string.
     * Used for transfer acknowledgment: sender hashes plaintext before encryption,
     * receiver hashes decrypted data, and both are compared to verify end-to-end
     * integrity (encryption + transfer + decryption all succeeded).
     *
     * @param {ArrayBuffer} data - Data to hash
     * @returns {Promise<string>} Lowercase hex string of SHA-256 hash
     */
    async sha256Hex(data) {
        const hash = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },

    /**
     * SHA-256 returning raw bytes. Used for per-segment digests in the v2
     * composite hash (see finalizeCompositeHash).
     * @param {ArrayBuffer|Uint8Array} data - Data to hash
     * @returns {Promise<Uint8Array>} 32-byte digest
     */
    async sha256Bytes(data) {
        return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    },

    /**
     * Composite file hash for the v2 segment format: SHA-256 over the
     * concatenated per-segment plaintext digests (data segments only, in
     * order; the metadata record is excluded). WebCrypto has no streaming
     * digest, so this is how both sides hash a multi-GiB file without ever
     * holding it in one buffer: each side digests the SEG_SIZE plaintext
     * windows of the original (uncompressed) file bytes as they pass, then
     * hashes the 32-bytes-per-segment digest list once at the end.
     *
     * Deterministic in (plaintext, segment size) and independent of file
     * salt, rewinds, and per-segment gzip, so it serves as the file
     * identity token everywhere the whole-file SHA-256 did (file-ack,
     * gallery delete/replace/transform matching).
     *
     * @param {Uint8Array[]} segmentDigests - One 32-byte digest per data segment
     * @returns {Promise<string>} Lowercase hex string (64 chars)
     */
    async finalizeCompositeHash(segmentDigests) {
        const all = new Uint8Array(segmentDigests.length * 32);
        for (let i = 0; i < segmentDigests.length; i++) {
            if (!ArrayBuffer.isView(segmentDigests[i]) || segmentDigests[i].byteLength !== 32) {
                throw new Error('Segment digest must be 32 bytes');
            }
            all.set(segmentDigests[i], i * 32);
        }
        return this.sha256Hex(all);
    },

    // ============ Utilities ============

    /**
     * Generate random bytes, working around the 65536-byte limit of getRandomValues.
     * Fills the array in chunks to support large buffers (e.g., for padding).
     * @param {number} length - Number of random bytes to generate
     * @returns {Uint8Array} Array filled with cryptographically random bytes
     */
    getRandomBytes(length) {
        const MAX_CHUNK = 65536; // Web Crypto API limit per call
        const result = new Uint8Array(length);
        for (let offset = 0; offset < length; offset += MAX_CHUNK) {
            const chunkSize = Math.min(MAX_CHUNK, length - offset);
            const chunk = new Uint8Array(chunkSize);
            crypto.getRandomValues(chunk);
            result.set(chunk, offset);
        }
        return result;
    },

    // ============ Padding for Size Obfuscation ============

    /**
     * Padding bucket sizes in bytes. Data is padded to the next bucket size
     * to hide the exact original size from observers. Uses power-of-2 buckets
     * for efficiency and to provide meaningful size obfuscation.
     */
    PADDING_BUCKETS: [
        16 * 1024,        // 16 KB - small images, thumbnails
        64 * 1024,        // 64 KB
        256 * 1024,       // 256 KB - typical compressed photos
        512 * 1024,       // 512 KB
        1024 * 1024,      // 1 MB
        2 * 1024 * 1024,  // 2 MB - high quality photos
        4 * 1024 * 1024,  // 4 MB
        8 * 1024 * 1024,  // 8 MB - very high resolution
        16 * 1024 * 1024, // 16 MB
        32 * 1024 * 1024  // 32 MB - maximum bucket
    ],

    /**
     * Get the padded size for a given original size.
     * Rounds up to the next bucket boundary to hide exact size.
     * @param {number} originalSize - Original data size in bytes
     * @returns {number} Padded size (next bucket boundary)
     */
    getPaddedSize(originalSize) {
        for (const bucket of this.PADDING_BUCKETS) {
            if (originalSize <= bucket) {
                return bucket;
            }
        }
        // For very large files, round up to nearest 32MB
        const maxBucket = this.PADDING_BUCKETS[this.PADDING_BUCKETS.length - 1];
        return Math.ceil(originalSize / maxBucket) * maxBucket;
    },

    /**
     * Encrypt file data along with its metadata, applying padding to hide size.
     *
     * Payload structure (before encryption):
     * [4 bytes: content_length] - original length of metadata_len + metadata + data
     * [4 bytes: metadata_length] - length of JSON metadata
     * [metadata JSON bytes]
     * [file data bytes]
     * [random padding to bucket boundary]
     *
     * This ensures:
     * 1. Metadata (filename, type, size) is encrypted and hidden
     * 2. Actual file size is hidden within a size bucket
     * 3. Padding is random bytes, not zeros, to prevent compression attacks
     *
     * @param {ArrayBuffer} data - File data to encrypt
     * @param {Object} metadata - Metadata object {name, mimeType, originalSize}
     * @param {CryptoKey} sharedKey - AES key derived from ECDH
     * @returns {Promise<ArrayBuffer>} Encrypted padded payload
     */
    /**
     * Compress an ArrayBuffer with gzip via CompressionStream. Returns null
     * if the runtime does not provide CompressionStream (very old browsers)
     * or if compression did not shrink the input. Compression happens
     * before encryption because ciphertext is incompressible; the
     * encoding flag travels inside the encrypted metadata block so it
     * remains end-to-end confidential.
     */
    async _maybeGzip(data) {
        if (typeof CompressionStream !== 'function') return null;
        try {
            const cs = new CompressionStream('gzip');
            const stream = new Blob([data]).stream().pipeThrough(cs);
            const buf = await new Response(stream).arrayBuffer();
            if (buf.byteLength < data.byteLength) {
                logger.info(`gzip: ${data.byteLength}B -> ${buf.byteLength}B (${Math.round(100 * buf.byteLength / data.byteLength)}%)`);
                return buf;
            }
            logger.info(`gzip: ${data.byteLength}B -> ${buf.byteLength}B (no win, sending raw)`);
            return null;
        } catch (e) {
            logger.warn('gzip failed, sending raw: ' + e.message);
            return null;
        }
    },

    async _gunzip(data) {
        const ds = new DecompressionStream('gzip');
        const stream = new Blob([data]).stream().pipeThrough(ds);
        return await new Response(stream).arrayBuffer();
    },

    async encryptWithMetadata(data, metadata, sharedKey) {
        // Try gzip before encryption. Encrypted bytes are random-looking
        // and thus incompressible, so compressing on the wire after
        // encryption would be wasted work; doing it here also keeps the
        // size-hiding padding pass downstream and the encoding flag
        // inside the encrypted metadata.
        const compressed = await this._maybeGzip(data);
        let dataArray;
        let metaForJson = metadata;
        if (compressed) {
            dataArray = new Uint8Array(compressed);
            metaForJson = Object.assign({}, metadata, { encoding: 'gzip' });
        } else {
            dataArray = new Uint8Array(data);
        }
        const metadataJson = JSON.stringify(metaForJson);
        const metadataBytes = new TextEncoder().encode(metadataJson);

        // Calculate sizes:
        // content = [4B metadata_len] + [metadata] + [data]
        const contentLength = 4 + metadataBytes.length + dataArray.length;
        // payload = [4B content_length] + [content] + [padding]
        const payloadBeforePadding = 4 + contentLength;
        const paddedSize = this.getPaddedSize(payloadBeforePadding);

        logger.info(`Padding payload from ${payloadBeforePadding} to ${paddedSize} bytes (bucket)`);

        // Create padded payload with random padding bytes
        // Using random padding prevents compression-based attacks
        // Note: getRandomValues has a 65536-byte limit per call, so we chunk it
        const payload = this.getRandomBytes(paddedSize);
        const view = new DataView(payload.buffer);

        let offset = 0;

        // Write content length (allows stripping padding on decrypt)
        view.setUint32(offset, contentLength, true); // little-endian
        offset += 4;

        // Write metadata length
        view.setUint32(offset, metadataBytes.length, true);
        offset += 4;

        // Write metadata JSON
        payload.set(metadataBytes, offset);
        offset += metadataBytes.length;

        // Write file data
        payload.set(dataArray, offset);
        // Remaining bytes are already random from getRandomValues

        // Encrypt the padded payload
        const encrypted = await this.encrypt(payload.buffer, sharedKey);

        logger.success(`Encrypted with metadata: ${dataArray.length}B data + ${metadataBytes.length}B metadata -> ${encrypted.byteLength}B encrypted`);
        return encrypted;
    },

    /**
     * Decrypt file data and extract metadata, removing padding.
     * Reverses the encryptWithMetadata operation.
     *
     * @param {ArrayBuffer} encryptedData - Encrypted padded payload from encryptWithMetadata
     * @param {CryptoKey} sharedKey - AES key derived from ECDH
     * @returns {Promise<{metadata: Object, data: ArrayBuffer}>} Decrypted metadata and file data
     */
    async decryptWithMetadata(encryptedData, sharedKey) {
        // Decrypt the payload
        const decrypted = await this.decrypt(encryptedData, sharedKey);
        const payload = new Uint8Array(decrypted);
        const view = new DataView(decrypted);

        let offset = 0;

        // Read content length (strips padding)
        const contentLength = view.getUint32(offset, true);
        offset += 4;

        // Validate content length to prevent buffer overflows
        if (contentLength > payload.length - 4 || contentLength < 4) {
            throw new Error('Invalid content length in decrypted payload');
        }

        // Read metadata length
        const metadataLength = view.getUint32(offset, true);
        offset += 4;

        // Validate metadata length
        if (metadataLength > contentLength - 4) {
            throw new Error('Invalid metadata length in decrypted payload');
        }

        // Extract metadata JSON
        const metadataBytes = payload.slice(offset, offset + metadataLength);
        const metadataJson = new TextDecoder().decode(metadataBytes);
        const metadata = JSON.parse(metadataJson);
        offset += metadataLength;

        // Extract file data (contentLength - 4 for metadata_len field - metadataLength)
        const dataLength = contentLength - 4 - metadataLength;
        const data = payload.slice(offset, offset + dataLength);

        logger.success(`Decrypted with metadata: ${data.length}B data, metadata: ${metadataJson.substring(0, 50)}...`);

        // If the sender gzip'd before encryption, undo it now. The flag
        // lives inside the encrypted metadata so an on-path observer
        // cannot tell whether a given payload was compressed. data is a
        // freshly-allocated slice (Uint8Array.prototype.slice copies)
        // so data.buffer is the exact dataLength bytes already.
        let outBuffer = data.buffer;
        if (metadata && metadata.encoding === 'gzip') {
            outBuffer = await this._gunzip(outBuffer);
            logger.success(`Decompressed gzip: ${data.length}B -> ${outBuffer.byteLength}B`);
        }

        return {
            metadata: metadata,
            data: outBuffer
        };
    }
};

// Export for use in other modules. Frozen so a hostile script (XSS, malicious
// browser extension, or compromised dependency loaded after this file) cannot
// monkey-patch deriveSharedKey / encryptWithMetadata / getCombinedFingerprint
// to subvert the E2EE handshake at runtime.
window.WebSendCrypto = Object.freeze(WebSendCrypto);
