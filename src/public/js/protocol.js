/**
 * WebRTC data-channel protocol schemas, validation, and message builders.
 * Exposes window.Protocol.
 * Built with Claude Code (Opus 4.7).
 */
(function () {
    const PROTOCOL_VERSION = 1;

    // Hard upper bound on a single encrypted-file payload. Padding tops out
    // around the next power of two above the largest plausible photo, so 1 GiB
    // is generous and still small enough that a hostile or buggy peer cannot
    // request a multi-GB allocation or break progress arithmetic.
    const MAX_FILE_SIZE = 1024 * 1024 * 1024;

    // Hard lower bound on a single encrypted-file payload. The smallest legitimate
    // ciphertext is one padding bucket (16 KiB) plus AES-GCM IV (12 B) and tag
    // (16 B). Anything below this is a malformed or hostile file-start that
    // upstream callers should drop. Defense-in-depth alongside the receiver-side
    // actual-byte cap.
    const MIN_FILE_START_SIZE = 16 * 1024;

    // Hard ceiling on the cumulative bytes a single peer may push across the
    // entire data-channel session. Even with the per-file expectedSize cap a
    // hostile peer could otherwise loop file-start/binary/file-end forever and
    // exhaust the receiver tab. 4 GiB is well above legitimate use (a camera
    // session of dozens of high-res photos rarely exceeds a few hundred MB).
    const MAX_TOTAL_SESSION_BYTES = 4 * 1024 * 1024 * 1024;

    // Hard ceiling on transforms[] length per transform-image message. A
    // legitimate sender batches at most a handful of edits (rotate/flip/bw/crop
    // chained); 32 leaves comfortable headroom while bounding receiver CPU.
    const MAX_TRANSFORMS_PER_MSG = 32;

    // Hard ceiling on the raw JSON-string size of any control message on
    // the data channel. The largest legitimate message is sender-public-key
    // whose `key` field is the base64 of an ECDH P-256 public key (~91
    // chars); 16 KiB is comfortable headroom for protocol growth and stops
    // a hostile peer from forcing a multi-MB allocation in JSON.parse on
    // the receiver before validate() ever runs.
    const MAX_CONTROL_MSG_BYTES = 16 * 1024;

    // Predicates used in schemas
    function isHex64(v) { return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v); }
    function isBoundedSize(v) {
        return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
            && v >= MIN_FILE_START_SIZE && v <= MAX_FILE_SIZE;
    }
    function isNormalizedCoord(v) {
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    }
    function isCornerObj(c) {
        return c && typeof c === 'object' && isNormalizedCoord(c.x) && isNormalizedCoord(c.y);
    }
    function isCornersForCrop(corners) {
        return corners && typeof corners === 'object'
            && isCornerObj(corners.tl) && isCornerObj(corners.tr)
            && isCornerObj(corners.br) && isCornerObj(corners.bl);
    }
    function isTransformArray(v) {
        if (!Array.isArray(v) || v.length === 0 || v.length > MAX_TRANSFORMS_PER_MSG) return false;
        const validOps = new Set(['rotateCW', 'flipH', 'bw', 'crop']);
        return v.every(t => {
            if (!t || !validOps.has(t.op)) return false;
            // crop carries normalized corners that must be in [0, 1]; other ops
            // have no parameters so any extra fields are ignored (forward-compat).
            if (t.op === 'crop') return isCornersForCrop(t.corners);
            return true;
        });
    }

    // Schema: { required: { field: 'string'|'number'|'boolean'|predicateFn } }
    // Fields not listed are allowed (forward-compat).
    const schemas = {
        'public-key':              { required: { key: 'string' } },
        'sender-public-key':       { required: { key: 'string' } },
        'fingerprint-confirmed':   {},
        'fingerprint-denied':      {},
        'ready':                   {},
        'file-start':              { required: { size: isBoundedSize } },
        'file-end':                {},
        'file-ack':                { required: { sha256: isHex64 } },
        'file-nack':               { required: { error: 'string' } },
        'delete-image':            { required: { hash: isHex64 } },
        'transform-image':         { required: { oldHash: isHex64, transforms: isTransformArray } },
        'transform-nack':          { required: { oldHash: isHex64, reason: 'string' } },
        'replace-image':           { required: { oldHash: isHex64 } },
        'batch-start':             {},
        'batch-start-if-nonempty': {},
        'batch-end':               {},
    };

    /**
     * Validate a message object against the schema for its type.
     * Returns { ok: true } or { ok: false, error: string }.
     */
    function validate(msg) {
        if (!msg || typeof msg !== 'object') return { ok: false, error: 'message is not an object' };
        const type = msg.type;
        if (typeof type !== 'string') return { ok: false, error: 'missing or non-string type' };
        const schema = schemas[type];
        if (!schema) return { ok: false, error: `unknown message type: ${type}` };
        const required = schema.required || {};
        for (const [field, check] of Object.entries(required)) {
            const val = msg[field];
            if (val === undefined || val === null) {
                return { ok: false, error: `${type}: missing required field '${field}'` };
            }
            if (typeof check === 'function') {
                if (!check(val)) return { ok: false, error: `${type}: field '${field}' failed validation` };
            } else {
                if (typeof val !== check) return { ok: false, error: `${type}: field '${field}' must be ${check}, got ${typeof val}` };
            }
        }
        return { ok: true };
    }

    function stamp(msg) { return Object.assign({ protocolVersion: PROTOCOL_VERSION }, msg); }

    const build = {
        publicKey:             (key)                     => stamp({ type: 'public-key',              key }),
        senderPublicKey:       (key)                     => stamp({ type: 'sender-public-key',       key }),
        fingerprintConfirmed:  ()                        => stamp({ type: 'fingerprint-confirmed' }),
        fingerprintDenied:     ()                        => stamp({ type: 'fingerprint-denied' }),
        ready:                 ()                        => stamp({ type: 'ready' }),
        fileStart:             (size)                    => stamp({ type: 'file-start',              size }),
        fileEnd:               ()                        => stamp({ type: 'file-end' }),
        fileAck:               (sha256)                  => stamp({ type: 'file-ack',                sha256 }),
        fileNack:              (error)                   => stamp({ type: 'file-nack',               error }),
        deleteImage:           (hash)                    => stamp({ type: 'delete-image',            hash }),
        transformImage:        (oldHash, transforms)     => stamp({ type: 'transform-image',         oldHash, transforms }),
        transformNack:         (oldHash, reason)         => stamp({ type: 'transform-nack',          oldHash, reason }),
        replaceImage:          (oldHash)                 => stamp({ type: 'replace-image',           oldHash }),
        batchStart:            ()                        => stamp({ type: 'batch-start' }),
        batchStartIfNonempty:  ()                        => stamp({ type: 'batch-start-if-nonempty' }),
        batchEnd:              ()                        => stamp({ type: 'batch-end' }),
    };

    window.Protocol = {
        VERSION: PROTOCOL_VERSION,
        MAX_FILE_SIZE,
        MIN_FILE_START_SIZE,
        MAX_TOTAL_SESSION_BYTES,
        MAX_TRANSFORMS_PER_MSG,
        MAX_CONTROL_MSG_BYTES,
        validate,
        build,
        _schemas: schemas,
    };
})();
