/**
 * Crypto module for ImageSecureSend
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

const ImageSecureSendCrypto = {
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
     * Derive a shared secret from our private key and their public key.
     * Uses ECDH to compute shared secret, then HKDF to derive AES key.
     * @param {CryptoKey} privateKey - Our ECDH private key
     * @param {CryptoKey} theirPublicKey - Their ECDH public key
     * @returns {Promise<CryptoKey>} AES-GCM key derived from shared secret
     */
    async deriveSharedKey(privateKey, theirPublicKey) {
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

        // Use HKDF to derive AES key from shared secret.
        // HKDF provides proper key derivation with domain separation.
        const hkdfKey = await crypto.subtle.importKey(
            'raw',
            sharedSecret,
            'HKDF',
            false,
            ['deriveKey']
        );

        const aesKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                // Salt provides randomness; using fixed value is acceptable for ECDH
                // since the shared secret itself is random per session
                salt: new TextEncoder().encode('ImageSecureSend-v1'),
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

        logger.success('Shared AES key derived');
        return aesKey;
    },

    /**
     * Compute SHA-256 fingerprint of a public key for visual verification.
     * Returns first 12 hex characters (48 bits) for human comparison.
     * 48 bits provides ~280 trillion combinations, making MITM key substitution
     * attacks impractical while remaining human-readable.
     * @param {CryptoKey} publicKey - The public key to fingerprint
     * @returns {Promise<string>} Short hex fingerprint (12 chars, grouped as XXXX-XXXX-XXXX)
     */
    async getKeyFingerprint(publicKey) {
        const exported = await crypto.subtle.exportKey('raw', publicKey);
        const hash = await crypto.subtle.digest('SHA-256', exported);
        const hashArray = new Uint8Array(hash);
        // Take first 6 bytes (12 hex chars / 48 bits) for human-readable verification
        const hexChars = Array.from(hashArray.slice(0, 6))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase();
        // Format as XXXX-XXXX-XXXX for easier visual comparison
        const fingerprint = `${hexChars.slice(0, 4)}-${hexChars.slice(4, 8)}-${hexChars.slice(8, 12)}`;
        return fingerprint;
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
    async encryptWithMetadata(data, metadata, sharedKey) {
        const metadataJson = JSON.stringify(metadata);
        const metadataBytes = new TextEncoder().encode(metadataJson);
        const dataArray = new Uint8Array(data);

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

        return {
            metadata: metadata,
            data: data.buffer
        };
    }
};

// Export for use in other modules
window.ImageSecureSendCrypto = ImageSecureSendCrypto;
