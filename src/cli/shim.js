/**
 * In-browser driver script for the CLI receiver.
 *
 * Loaded into a Playwright-launched Chromium page that has been navigated to
 * the WebSend instance origin (so fetch() carries the right Origin header and
 * crypto.js / protocol.js have already been added via addScriptTag).
 *
 * Exposes window.__wsCli with start({ baseUrl, autoAccept }) → Promise<void>
 * that drives the entire receiver flow:
 *
 *   1. Generate ECDH keypair, POST /api/rooms, create RTCPeerConnection +
 *      data channel, post offer, trickle ICE, long-poll for answer.
 *   2. Once the data channel opens, send our public key, derive shared key
 *      from the sender's, and surface the fingerprints.
 *   3. Bridge file saves and the y/n fingerprint prompt back to Node via
 *      previously-exposed window.__nodeLog / __nodeSaveFile / __nodePromptFp.
 *
 * Reuses src/public/js/crypto.js, protocol.js, and segment-stream.js
 * verbatim — the wire protocol cannot drift because we load the same files
 * the production receiver loads. Receives the v2 chunked format (sealed
 * segment records); the in-connection segment-nack retry dance is NOT
 * implemented (WebRTC's ordered reliable channel makes record corruption
 * a non-event), so any verification failure nacks the whole file.
 *
 * Built with the help of Claude Code (Opus 4.7).
 */
(function () {
    const log = (lvl, msg) => { try { window.__nodeLog(lvl, msg); } catch (_) {} };

    // Minimal logger shim required by crypto.js.
    if (!window.logger) {
        window.logger = {
            info:    (m) => log('dbg', m),
            success: (m) => log('dbg', m),
            warn:    (m) => log('warn', m),
            error:   (m) => log('err', m),
            debug:   (m) => log('dbg', m),
        };
    }

    async function httpJson(url, init) {
        const res = await fetch(url, init);
        const text = await res.text();
        if (!res.ok && res.status !== 204) {
            throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
        }
        if (res.status === 204 || !text) return null;
        return JSON.parse(text);
    }

    function arrayBufferToBase64(buf) {
        const bytes = new Uint8Array(buf);
        let s = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(s);
    }

    async function start({ baseUrl, autoAccept }) {
        const C = window.WebSendCrypto;
        const P = window.Protocol;
        const SS = window.SegmentStream;
        if (!C || !P || !SS) throw new Error('crypto.js / protocol.js / segment-stream.js not loaded');
        log('info', `Protocol v${P.VERSION}`);

        const config = await httpJson(`${baseUrl}/api/config`);

        const rtcConfig = {
            iceServers: (config?.iceServers || []).filter(s => s && s.urls),
        };
        if (config?.iceTransportPolicy) rtcConfig.iceTransportPolicy = config.iceTransportPolicy;

        const keyPair = await C.generateKeyPair();
        const myPubB64 = await C.exportPublicKey(keyPair.publicKey);

        log('info', 'Creating room...');
        const room = await httpJson(`${baseUrl}/api/rooms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        const { roomId, secret } = room;
        log('ok', `Room ${roomId} created`);

        const auth = { 'Content-Type': 'application/json', 'X-Room-Secret': secret };

        const pc = new RTCPeerConnection(rtcConfig);
        const dc = pc.createDataChannel('websend', { ordered: true });
        dc.binaryType = 'arraybuffer';

        // Local ICE candidates only need to be logged in -v; we do NOT trickle
        // them to the server. Unlike the production receiver (which posts its
        // offer immediately and trickles candidates via /ice/offer), this CLI
        // keeps the simpler embed-everything approach: wait for gathering,
        // post the offer with all candidates inline. The production sender
        // handles both shapes: it reads embedded candidates from the SDP and
        // also polls /ice/offer at 1 Hz for trickled ones.
        pc.onicecandidate = (ev) => {
            if (!ev.candidate) { log('dbg', 'local ICE gathering complete'); return; }
            log('dbg', `local ICE: ${ev.candidate.candidate.slice(0, 80)}`);
        };

        pc.oniceconnectionstatechange = () => log('dbg', `ice state: ${pc.iceConnectionState}`);
        pc.onconnectionstatechange     = () => log('dbg', `pc state:  ${pc.connectionState}`);
        pc.onicegatheringstatechange   = () => log('dbg', `gather:    ${pc.iceGatheringState}`);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering to complete with a TURN-aware timeout (the
        // CLI embeds all candidates in the offer instead of trickling).
        const hasTurn = (rtcConfig.iceServers || []).some(s => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
            return urls.some(u => typeof u === 'string' && (u.startsWith('turn:') || u.startsWith('turns:')));
        });
        const gatherTimeoutMs = (rtcConfig.iceTransportPolicy === 'relay' || hasTurn)
            ? (config?.turnTimeout ? config.turnTimeout * 1000 : 15000)
            : 5000;
        log('info', `Gathering ICE candidates (timeout ${gatherTimeoutMs / 1000}s)...`);
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') return resolve();
            const t = setTimeout(() => {
                log('warn', 'ICE gathering timeout, posting available candidates');
                resolve();
            }, gatherTimeoutMs);
            pc.addEventListener('icegatheringstatechange', () => {
                if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
            });
        });

        // Post the fully-gathered offer (candidates baked into SDP).
        const finalSdp = pc.localDescription.sdp;
        log('dbg', `posting offer (${finalSdp.length} chars, candidates inline)`);
        await httpJson(`${baseUrl}/api/rooms/${roomId}/offer`, {
            method: 'POST', headers: auth,
            body: JSON.stringify({ type: 'offer', sdp: finalSdp }),
        });

        const senderUrl = `${baseUrl}/send/${roomId}#${secret}`;
        try { window.__nodeSenderUrl(senderUrl); } catch (_) {}

        // Long-poll for answer. The server returns 204 (null body) if no answer
        // arrives within 30s — we just retry.
        log('info', 'Waiting for sender to connect...');
        let answer = null;
        let attempt = 0;
        while (!answer) {
            attempt += 1;
            log('dbg', `answer long-poll #${attempt}...`);
            answer = await httpJson(`${baseUrl}/api/rooms/${roomId}/answer?wait=true`, { headers: auth });
            if (!answer) log('dbg', `long-poll #${attempt} timed out (204), retrying`);
        }
        log('ok', `Got answer SDP (${answer.sdp.length} chars)`);
        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
        log('dbg', 'remoteDescription set');

        // Trickle remote ICE candidates.
        const seen = new Set();
        let polling = true;
        (async function pollIce() {
            while (polling) {
                try {
                    const r = await httpJson(`${baseUrl}/api/rooms/${roomId}/ice/answer`, { headers: auth });
                    for (const c of (r?.candidates || [])) {
                        const k = `${c.candidate}|${c.sdpMid}|${c.sdpMLineIndex}`;
                        if (seen.has(k)) continue;
                        seen.add(k);
                        log('dbg', `remote ICE: ${String(c.candidate).slice(0, 80)}`);
                        try { await pc.addIceCandidate(c); } catch (e) { log('warn', `addIceCandidate: ${e.message}`); }
                    }
                } catch (e) { log('dbg', `ICE poll: ${e.message}`); }
                if (pc.connectionState === 'connected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') return;
                await new Promise(r => setTimeout(r, 1000));
            }
        })();

        await new Promise((resolve, reject) => {
            if (dc.readyState === 'open') return resolve();
            dc.onopen = () => resolve();
            dc.onerror = (e) => reject(new Error(`dc error: ${e?.message || e}`));
        });
        log('ok', 'Data channel open');

        let sessionKeys = null;
        // v2 receive state: the SegmentReceiver for the in-flight file plus
        // the streaming record parser's partial-record buffer and the next
        // record seq the wire may carry (mirrors transport-assembler.js).
        let receiver = null;
        let pending = null;      // Uint8Array, at most one partial record
        let wireNextSeq = 0;
        // Records funnel through one promise chain because accept() is
        // async and records must verify strictly in order.
        let recordChain = Promise.resolve();
        // Verified-fingerprint gate. Mirrors VERIFIED_GATED_HANDLERS in
        // receive.html: state-mutating peer messages and binary chunks are
        // dropped until both sides confirm the ECDH fingerprint.
        let weConfirmed = false, theyConfirmed = false;
        // Cumulative bytes since dc opened, bounded by Protocol.MAX_TOTAL_SESSION_BYTES.
        // Mirrors WebSendRTC._sessionTotalBytes (src/public/js/webrtc.js).
        let sessionTotalBytes = 0;
        // Latched once we tear down for protocol abuse so trailing chunks no-op.
        let abusiveTeardown = false;
        const state = { savedCount: 0, savedBytes: 0 };

        const send = (m) => dc.send(JSON.stringify(m));

        // Tear down on detected protocol abuse. Same shape as
        // WebSendRTC._abortAbusiveStream: latch, close channel + pc, surface
        // the abort to the Node side via __nodeDone so receive.js can exit
        // with a non-zero status instead of a confused stack trace.
        const abortAbusive = (reason) => {
            if (abusiveTeardown) return;
            abusiveTeardown = true;
            log('err', `Aborting peer connection: ${reason}`);
            receiver = null; pending = null;
            try { dc.close(); } catch (_) {}
            try { pc.close(); } catch (_) {}
            try { window.__nodeDone({ ...state, abusive: true, reason }); } catch (_) {}
        };

        // Verify one framed record against the in-flight SegmentReceiver.
        // No segment-nack retry here (see header comment): a failure nacks
        // the whole file and the sender surfaces its retry toast.
        const acceptRecord = async (seq, ct) => {
            if (!receiver) return; // dropped transfer; ignore tail records
            const res = await receiver.accept(seq, ct);
            if (!res.ok) {
                log('err', `record ${seq} rejected (${res.reason})`);
                receiver = null;
                send(P.build.fileNack('decrypt-failed'));
            }
        };

        dc.onmessage = async (ev) => {
            try {
                if (abusiveTeardown) return;
                const d = ev.data;
                if (typeof d === 'string') {
                    const msg = JSON.parse(d);
                    const vr = P.validate(msg);
                    if (!vr.ok) { log('warn', `drop: ${vr.error}`); return; }
                    // Peer-controlled handlers that mutate state or run heavy
                    // work on peer-supplied parameters: drop until both sides
                    // confirm the fingerprint. Mirrors
                    // VERIFIED_GATED_HANDLERS in src/public/receive.html.
                    const verifiedGated = (
                        msg.type === 'file-start' ||
                        msg.type === 'file-end' ||
                        msg.type === 'batch-end'
                    );
                    if (verifiedGated && !(weConfirmed && theyConfirmed)) {
                        log('warn', `Dropping ${msg.type} from unverified peer`);
                        return;
                    }
                    if (msg.type === 'sender-public-key') {
                        const theirPub = await C.importPublicKey(msg.key);
                        sessionKeys = await C.deriveSessionKeys(keyPair.privateKey, theirPub);
                        const code = await C.getCombinedFingerprint(keyPair.publicKey, theirPub);
                        const ok = autoAccept ? true : await window.__nodePromptFp(code);
                        if (ok) {
                            weConfirmed = true;
                            send(P.build.fingerprintConfirmed());
                            log('ok', 'Fingerprint confirmed');
                        }
                        else { send(P.build.fingerprintDenied()); log('err', 'Denied'); try { dc.close(); } catch {} }
                    } else if (msg.type === 'fingerprint-confirmed') {
                        theyConfirmed = true;
                        log('dbg', 'sender confirmed');
                    } else if (msg.type === 'fingerprint-denied') {
                        log('err', 'sender denied');
                        try { dc.close(); } catch {}
                    } else if (msg.type === 'file-start') {
                        if (msg.v !== 2) {
                            log('err', `file-start with unsupported version (v=${msg.v}); nacking`);
                            send(P.build.fileNack('unsupported-version'));
                            return;
                        }
                        if (!sessionKeys) { log('err', 'file-start before key derived'); return; }
                        receiver = SS.createReceiver({
                            sessionKeys,
                            saltB64: msg.salt,
                            segCount: msg.segCount,
                        });
                        pending = null;
                        wireNextSeq = 0;
                        log('info', `Receiving file (${msg.segCount} segments)...`);
                    } else if (msg.type === 'file-end') {
                        recordChain = recordChain.then(async () => {
                            if (!receiver) return;
                            const r = receiver;
                            receiver = null; pending = null;
                            if (r.nextSeq !== r.segCount + 1) {
                                log('err', `file-end after ${r.nextSeq}/${r.segCount + 1} records`);
                                send(P.build.fileNack('incomplete'));
                                return;
                            }
                            const { metadata, blob, compositeHashHex } = await r.finish();
                            const b64 = arrayBufferToBase64(await blob.arrayBuffer());
                            const path = await window.__nodeSaveFile(
                                (metadata && metadata.name) || 'unnamed',
                                (metadata && metadata.mimeType) || '', b64);
                            send(P.build.fileAck(compositeHashHex));
                            state.savedCount += 1;
                            state.savedBytes += blob.size;
                            log('ok', `Saved ${path} (${blob.size} bytes)`);
                        }).catch((e) => {
                            send(P.build.fileNack('decrypt-failed'));
                            log('err', `finalize failed: ${e.message}`);
                        });
                        await recordChain;
                    } else if (msg.type === 'batch-end') {
                        log('ok', 'Batch ended');
                    } else {
                        log('dbg', `(ignored) ${msg.type}`);
                    }
                } else {
                    // Binary chunk (ArrayBuffer because dc.binaryType = 'arraybuffer').
                    // Streaming v2 record parser with the same defense-in-depth
                    // bounds as transport-assembler.js handleBinaryV2: at most
                    // one partial record buffered, ctLen hard-bounded, seq may
                    // never skip ahead, session bytes capped.
                    if (!(weConfirmed && theyConfirmed)) {
                        return abortAbusive('binary chunk from unverified peer');
                    }
                    const len = d.byteLength | 0;
                    if (sessionTotalBytes + len > P.MAX_TOTAL_SESSION_BYTES) {
                        return abortAbusive(
                            `session byte cap exceeded (${sessionTotalBytes + len} > ${P.MAX_TOTAL_SESSION_BYTES})`
                        );
                    }
                    sessionTotalBytes += len;
                    if (!receiver) return; // no transfer in flight: drop in O(1)

                    const pendingLen = pending ? pending.length : 0;
                    const merged = new Uint8Array(pendingLen + len);
                    if (pendingLen) merged.set(pending, 0);
                    merged.set(new Uint8Array(d), pendingLen);

                    // Largest legal record ct: a full segment's plaintext
                    // ([1B flags][4B dataLen] + SEG_SIZE) plus the GCM tag.
                    const maxCt = P.SEG_SIZE + 21;
                    let offset = 0;
                    while (merged.length - offset >= 8) {
                        const view = new DataView(merged.buffer, offset);
                        const seq = view.getUint32(0, false);
                        const ctLen = view.getUint32(4, false);
                        if (ctLen < 16 || ctLen > maxCt) {
                            return abortAbusive(`record ciphertext length ${ctLen} out of bounds`);
                        }
                        if (seq > wireNextSeq) {
                            return abortAbusive(`record seq ${seq} skipped ahead of expected ${wireNextSeq}`);
                        }
                        if (merged.length - offset < 8 + ctLen) break; // partial record
                        const ct = merged.slice(offset + 8, offset + 8 + ctLen);
                        offset += 8 + ctLen;
                        wireNextSeq = seq + 1;
                        recordChain = recordChain
                            .then(() => acceptRecord(seq, ct.buffer))
                            .catch((e) => log('err', `record ${seq}: ${e.message}`));
                    }
                    pending = offset < merged.length ? merged.slice(offset) : null;
                }
            } catch (e) {
                log('err', `handler: ${e.message}`);
            }
        };

        dc.onclose = () => {
            polling = false;
            log('info', 'Data channel closed');
            try { window.__nodeDone(state); } catch (_) {}
        };

        // First wire message: our public key.
        send(P.build.publicKey(myPubB64));
    }

    window.__wsCli = { start };
})();
