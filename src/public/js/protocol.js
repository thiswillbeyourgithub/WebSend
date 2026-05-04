/**
 * WebRTC data-channel protocol schemas, validation, and message builders.
 * Exposes window.Protocol.
 * Built with Claude Code (Opus 4.7).
 */
(function () {
    const PROTOCOL_VERSION = 1;

    // Predicates used in schemas
    function isHex64(v) { return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v); }
    function isTransformArray(v) {
        if (!Array.isArray(v) || v.length === 0) return false;
        const validOps = new Set(['rotateCW', 'flipH', 'bw', 'crop']);
        return v.every(t => t && validOps.has(t.op));
    }

    // Schema: { required: { field: 'string'|'number'|'boolean'|predicateFn } }
    // Fields not listed are allowed (forward-compat).
    const schemas = {
        'public-key':              { required: { key: 'string' } },
        'sender-public-key':       { required: { key: 'string' } },
        'fingerprint-confirmed':   {},
        'fingerprint-denied':      {},
        'ready':                   {},
        'file-start':              { required: { size: 'number' } },
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

    window.Protocol = { VERSION: PROTOCOL_VERSION, validate, build, _schemas: schemas };
})();
