/**
 * WebRTC data-channel protocol schemas, validation, and message builders.
 * Exposes window.Protocol.
 * Built with Claude Code (Opus 4.7).
 */
(function () {
    const PROTOCOL_VERSION = 1;

    // Hard upper bound on a single file. Bounds MAX_SEG_COUNT below, so a
    // hostile or buggy peer cannot request an oversized record stream or
    // break progress arithmetic. 4 GiB: the v2 chunked format holds one
    // segment at a time, so receiver memory no longer scales with this.
    const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;

    // Hard ceiling on the cumulative bytes a single peer may push across the
    // entire data-channel session. Even with the per-file segCount cap a
    // hostile peer could otherwise loop file-start/binary/file-end forever
    // and exhaust the receiver tab. 8 GiB = one max-size file plus wire
    // overhead plus a full rewound resend of its tail (every rewind/resume
    // re-sends records that already counted against the session).
    const MAX_TOTAL_SESSION_BYTES = 8 * 1024 * 1024 * 1024;

    // v2 chunked-file format: plaintext bytes per data segment. Fixed for
    // now (the file-start field exists for forward compatibility); both the
    // composite file hash and the resume protocol assume every peer uses
    // the same window, so do not make this negotiable without versioning.
    const SEG_SIZE = 256 * 1024;

    // Upper bound on data segments per file, derived from the file cap so
    // the two can never disagree. Record seqs run 0 (metadata record) to
    // segCount, so this also bounds every seq field below.
    const MAX_SEG_COUNT = MAX_FILE_SIZE / SEG_SIZE;

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
    function isNonNegativeInt(v) {
        return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
    }
    function isFileSalt(v) {
        // base64 of exactly 16 bytes: 22 significant chars + '==' padding
        return typeof v === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(v);
    }
    function isSeqInRange(v) {
        return isNonNegativeInt(v) && v <= MAX_SEG_COUNT;
    }
    function isNextSeqInRange(v) {
        // nextSeq may be segCount + 1 ("I had everything but the file-end")
        return isNonNegativeInt(v) && v <= MAX_SEG_COUNT + 1;
    }
    // file-start v2 {v: 2, segSize, segCount, salt} (chunked AEAD). It
    // deliberately carries NO plaintext size; the exact size lives inside
    // the encrypted metadata record so padding keeps hiding it, and
    // segCount only reveals size to SEG_SIZE granularity (which the wire
    // traffic reveals anyway).
    function isFileStartShape(msg) {
        if (msg.v === 2) {
            return msg.segSize === SEG_SIZE
                && isNonNegativeInt(msg.segCount) && msg.segCount >= 1 && msg.segCount <= MAX_SEG_COUNT
                && isFileSalt(msg.salt);
        }
        // Unknown or legacy version (the removed v1 whole-file format has
        // no v field): allowed through validation only so the receive flow
        // can answer file-nack('unsupported-version') instead of silently
        // dropping (the sender would otherwise time out unexplained). Any
        // binary that follows is rejected by the record parser.
        return msg.v === undefined || isNonNegativeInt(msg.v);
    }
    // file-resume-offer {nextSeq}: "I have an in-flight v2 transfer and
    // verified every record below nextSeq; resume from there if you can."
    function isFileResumeOfferShape(msg) {
        return isNextSeqInRange(msg.nextSeq);
    }
    // file-resume-ack {nextSeq, salt}. nextSeq === 0 means "cannot resume,
    // expect a fresh file-start" and needs no salt; a positive nextSeq
    // re-keys the tail, so the fresh salt is mandatory.
    function isFileResumeAckShape(msg) {
        if (!isNextSeqInRange(msg.nextSeq)) return false;
        return msg.nextSeq === 0 || isFileSalt(msg.salt);
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

    // Schema: { required: { field: 'string'|'number'|'boolean'|predicateFn },
    //           check: wholeMessagePredicate }
    // `check` runs after the required fields and sees the full message; it
    // exists for the messages whose valid shape depends on another field
    // (file-start versioning, resume-ack salt rules). Fields not listed
    // are allowed (forward-compat).
    const schemas = {
        'public-key':              { required: { key: 'string' } },
        'sender-public-key':       { required: { key: 'string' } },
        'fingerprint-confirmed':   {},
        'fingerprint-denied':      {},
        'ready':                   {},
        'file-start':              { check: isFileStartShape },
        'file-end':                {},
        'file-ack':                { required: { sha256: isHex64 } },
        'file-nack':               { required: { error: 'string' } },
        // segment-nack: receiver → sender mid-transfer (v2). "Record {seq}
        // failed authentication (or never arrived); rewind to it." The
        // sender answers with segment-rewind and resends from there.
        'segment-nack':            { required: { seq: isSeqInRange } },
        // segment-rewind: sender → receiver (v2), strictly in-band BEFORE
        // the resent records. Carries the fresh file salt that re-keys the
        // tail so a (key, nonce) pair is never reused across the rewind.
        'segment-rewind':          { required: { seq: isSeqInRange, salt: isFileSalt } },
        // file-resume-offer: receiver → sender after a transport reconnect.
        // "I have an in-flight transfer; here is how far I verifiably got;
        // resume from there if you can."
        'file-resume-offer':       { check: isFileResumeOfferShape },
        // file-resume-ack: sender → receiver. nextSeq 0 means "I cannot
        // resume, expect a fresh file-start".
        'file-resume-ack':         { check: isFileResumeAckShape },
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
        if (schema.check && !schema.check(msg)) {
            return { ok: false, error: `${type}: message failed shape validation` };
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
        fileStartV2:           (segCount, salt)          => stamp({ type: 'file-start',              v: 2, segSize: SEG_SIZE, segCount, salt }),
        fileEnd:               ()                        => stamp({ type: 'file-end' }),
        fileAck:               (sha256)                  => stamp({ type: 'file-ack',                sha256 }),
        fileNack:              (error)                   => stamp({ type: 'file-nack',               error }),
        segmentNack:           (seq)                     => stamp({ type: 'segment-nack',            seq }),
        segmentRewind:         (seq, salt)               => stamp({ type: 'segment-rewind',          seq, salt }),
        fileResumeOfferV2:     (nextSeq)                 => stamp({ type: 'file-resume-offer',       nextSeq }),
        fileResumeAckV2:       (nextSeq, salt)           => stamp(salt === undefined
            ? { type: 'file-resume-ack', nextSeq }
            : { type: 'file-resume-ack', nextSeq, salt }),
        deleteImage:           (hash)                    => stamp({ type: 'delete-image',            hash }),
        transformImage:        (oldHash, transforms)     => stamp({ type: 'transform-image',         oldHash, transforms }),
        transformNack:         (oldHash, reason)         => stamp({ type: 'transform-nack',          oldHash, reason }),
        replaceImage:          (oldHash)                 => stamp({ type: 'replace-image',           oldHash }),
        batchStart:            ()                        => stamp({ type: 'batch-start' }),
        batchStartIfNonempty:  ()                        => stamp({ type: 'batch-start-if-nonempty' }),
        batchEnd:              ()                        => stamp({ type: 'batch-end' }),
    };

    // Freeze the build sub-object so a hostile script cannot swap
    // build.fingerprintConfirmed / build.transformNack with a tampering
    // variant after this module has been loaded.
    Object.freeze(build);
    window.Protocol = Object.freeze({
        VERSION: PROTOCOL_VERSION,
        MAX_FILE_SIZE,
        SEG_SIZE,
        MAX_SEG_COUNT,
        MAX_TOTAL_SESSION_BYTES,
        MAX_TRANSFORMS_PER_MSG,
        MAX_CONTROL_MSG_BYTES,
        validate,
        build,
        _schemas: schemas,
    });
})();
