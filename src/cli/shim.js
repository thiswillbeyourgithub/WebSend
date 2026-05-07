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
 * Reuses src/public/js/crypto.js and src/public/js/protocol.js verbatim — the
 * wire protocol cannot drift because we load the same files the production
 * receiver loads.
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
        if (!C || !P) throw new Error('crypto.js / protocol.js not loaded');
        log('info', `Protocol v${P.VERSION}`);

        const config = await httpJson(`${baseUrl}/api/config`);
        const stats  = await httpJson(`${baseUrl}/api/stats`).catch(() => ({ activeRooms: 0 }));
        const fpLen  = C.computeFingerprintLength(stats?.activeRooms ?? 0);

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
        // them to the server. The production receiver waits for ICE gathering
        // to complete and posts the offer with all candidates inline (see
        // webrtc.js:506 createOfferAndStore + waitForICE), and the sender
        // expects the offer SDP to contain candidates rather than polling
        // /ice/offer aggressively. Trickling races against TURNS gathering
        // and the sender's connection-timeout, which is exactly the failure
        // mode we hit (ICE went straight to disconnected/failed before remote
        // candidates were added).
        pc.onicecandidate = (ev) => {
            if (!ev.candidate) { log('dbg', 'local ICE gathering complete'); return; }
            log('dbg', `local ICE: ${ev.candidate.candidate.slice(0, 80)}`);
        };

        pc.oniceconnectionstatechange = () => log('dbg', `ice state: ${pc.iceConnectionState}`);
        pc.onconnectionstatechange     = () => log('dbg', `pc state:  ${pc.connectionState}`);
        pc.onicegatheringstatechange   = () => log('dbg', `gather:    ${pc.iceGatheringState}`);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering to complete with a TURN-aware timeout (matches
        // production webrtc.js waitForICE).
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

        let sharedKey = null;
        let buffer = [], bufSize = 0, expected = 0;
        const state = { savedCount: 0, savedBytes: 0 };

        const send = (m) => dc.send(JSON.stringify(m));

        dc.onmessage = async (ev) => {
            try {
                const d = ev.data;
                if (typeof d === 'string') {
                    const msg = JSON.parse(d);
                    const vr = P.validate(msg);
                    if (!vr.ok) { log('warn', `drop: ${vr.error}`); return; }
                    if (msg.type === 'sender-public-key') {
                        const theirPub = await C.importPublicKey(msg.key);
                        sharedKey = await C.deriveSharedKey(keyPair.privateKey, theirPub);
                        const myFp    = await C.getKeyFingerprint(keyPair.publicKey, fpLen);
                        const theirFp = await C.getKeyFingerprint(theirPub, fpLen);
                        const ok = autoAccept ? true : await window.__nodePromptFp(myFp, theirFp);
                        if (ok) { send(P.build.fingerprintConfirmed()); log('ok', 'Fingerprint confirmed'); }
                        else { send(P.build.fingerprintDenied()); log('err', 'Denied'); try { dc.close(); } catch {} }
                    } else if (msg.type === 'fingerprint-confirmed') {
                        log('dbg', 'sender confirmed');
                    } else if (msg.type === 'fingerprint-denied') {
                        log('err', 'sender denied');
                        try { dc.close(); } catch {}
                    } else if (msg.type === 'file-start') {
                        buffer = []; bufSize = 0; expected = msg.size;
                        log('info', `Receiving file (${msg.size} bytes encrypted+padded)...`);
                    } else if (msg.type === 'file-end') {
                        const blob = new Blob(buffer);
                        const arr = await blob.arrayBuffer();
                        buffer = []; bufSize = 0;
                        if (!sharedKey) { log('err', 'file-end before key derived'); return; }
                        try {
                            const dec = await C.decryptWithMetadata(arr, sharedKey);
                            const b64 = arrayBufferToBase64(dec.data);
                            const sha = await C.sha256Hex(dec.data);
                            const path = await window.__nodeSaveFile(dec.metadata.name || 'unnamed', dec.metadata.mimeType || '', b64);
                            send(P.build.fileAck(sha));
                            state.savedCount += 1;
                            state.savedBytes += dec.data.byteLength;
                            log('ok', `Saved ${path} (${dec.data.byteLength} bytes)`);
                        } catch (e) {
                            send(P.build.fileNack(`decrypt failed: ${e.message}`));
                            log('err', `decryption failed: ${e.message}`);
                        }
                    } else if (msg.type === 'batch-end') {
                        log('ok', 'Batch ended');
                    } else {
                        log('dbg', `(ignored) ${msg.type}`);
                    }
                } else {
                    // Binary chunk (ArrayBuffer because dc.binaryType = 'arraybuffer')
                    buffer.push(d);
                    bufSize += d.byteLength;
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
