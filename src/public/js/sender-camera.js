/**
 * sender-camera.js
 *
 * Owns the sender's camera-related concerns: QR scanner, photo-capture
 * camera, flash/torch + ImageCapture fallback, live document-corner
 * detection overlay, pinch-to-zoom, and per-frame photo capture.
 *
 * Extracted from send.html as part of the modular refactor (mirrors
 * sender-send.js / sender-gallery.js).
 *
 * Exposed as window.SenderCamera.
 * Generated with the help of Claude Code.
 */
(function () {
    'use strict';

    // -- Camera/scanner state --
    let scannerStream = null;
    let captureStream = null;
    let cameraZoom = 1;
    let lastPinchDist = 0;

    // Flash modes: 'off' → 'torch' (constant) → 'flash' (fire on capture) → 'off'
    let flashMode = 'off';
    let torchSupported = false;
    let fillLightSupported = false;
    let cachedImageCapture = null;

    // Document detection state
    let detectEnabled = localStorage.getItem('docDetectEnabled') === 'true';
    let detectInterval = null;
    let lastDetectedCorners = null;

    // -- Wired-in deps --
    let _getRtc = null;
    let _i18n = null;
    let _logger = null;
    let _showToast = null;
    let _onPhotoCaptured = null;
    let _onScanResult = null;

    function attach(deps) {
        _getRtc = deps.getRtc;
        _i18n = deps.i18n;
        _logger = deps.logger;
        _showToast = deps.showToast;
        _onPhotoCaptured = deps.onPhotoCaptured;

        // Pinch-to-zoom on both camera surfaces (the elements exist by now)
        setupPinchZoom(document.getElementById('scanner-video'));
        setupPinchZoom(document.getElementById('capture-video'));

        // Detect toggle wiring (state restored from localStorage above)
        setupDetectButton();
    }

    // ============ QR Scanner ============

    async function startScanner(opts) {
        _onScanResult = (opts && opts.onResult) || null;
        _logger.info('Starting QR scanner...');
        const video = document.getElementById('scanner-video');
        const container = video.parentElement;

        try {
            scannerStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' }
            });
            video.srcObject = scannerStream;
            container.classList.add('active');
            video.play();

            document.getElementById('start-scan-btn').textContent = _i18n.t('send.scanning');
            document.getElementById('start-scan-btn').disabled = true;

            video.addEventListener('loadeddata', () => {
                container.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, { once: true });

            requestAnimationFrame(scanFrame);
        } catch (e) {
            _logger.error('Failed to start camera: ' + e.message);
            _showToast(_i18n.t('send.cameraError'));
        }
    }

    function scanFrame() {
        if (!scannerStream) return;

        const video = document.getElementById('scanner-video');
        if (video.readyState !== video.HAVE_ENOUGH_DATA) {
            requestAnimationFrame(scanFrame);
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
        });

        if (code) {
            _logger.success('QR code detected!');
            stopScanner();
            if (_onScanResult) _onScanResult(code.data);
        } else {
            requestAnimationFrame(scanFrame);
        }
    }

    function stopScanner() {
        const video = document.getElementById('scanner-video');
        const container = video.parentElement;
        if (scannerStream) {
            scannerStream.getTracks().forEach(track => track.stop());
            scannerStream = null;
        }
        video.srcObject = null;
        container.classList.remove('active');
        resetCameraZoom(video);
        const startBtn = document.getElementById('start-scan-btn');
        const iconSpan = document.createElement('span');
        iconSpan.className = 'btn-icon';
        iconSpan.textContent = '📷';
        const labelSpan = document.createElement('span');
        labelSpan.setAttribute('data-i18n', 'send.startCamera');
        labelSpan.textContent = _i18n.t('send.startCamera');
        startBtn.replaceChildren(iconSpan, document.createTextNode(' '), labelSpan);
        startBtn.disabled = false;
    }

    // ============ Capture Camera ============

    async function startCapture() {
        _logger.info('Starting camera for capture...');

        const video = document.getElementById('capture-video');
        const container = video.parentElement;

        try {
            captureStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 3840 },
                    height: { ideal: 2160 },
                }
            });
            video.srcObject = captureStream;
            container.classList.add('active');
            video.play();

            // Tell receiver to start a new collection if previous batch had images
            const rtc = _getRtc();
            if (rtc) rtc.sendMessage(window.Protocol.build.batchStartIfNonempty());

            const track = captureStream.getVideoTracks()[0];
            try {
                const caps = track.getCapabilities ? track.getCapabilities() : {};
                const advanced = {};
                if (caps.focusMode && caps.focusMode.includes('continuous')) {
                    advanced.focusMode = 'continuous';
                }
                if (caps.exposureMode && caps.exposureMode.includes('continuous')) {
                    advanced.exposureMode = 'continuous';
                }
                if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) {
                    advanced.whiteBalanceMode = 'continuous';
                }
                if (Object.keys(advanced).length > 0) {
                    await track.applyConstraints({ advanced: [advanced] });
                    _logger.info('Applied advanced camera constraints: ' + JSON.stringify(advanced));
                }

                torchSupported = !!(caps.torch);
                fillLightSupported = false;
                if (!torchSupported && typeof ImageCapture !== 'undefined') {
                    try {
                        cachedImageCapture = new ImageCapture(track);
                        const photoCaps = await cachedImageCapture.getPhotoCapabilities();
                        if (photoCaps.fillLightMode && photoCaps.fillLightMode.length > 1) {
                            fillLightSupported = true;
                            _logger.info('Flash via ImageCapture fillLightMode: ' + JSON.stringify(photoCaps.fillLightMode));
                        } else {
                            cachedImageCapture = null;
                        }
                    } catch (icErr) {
                        _logger.info('ImageCapture flash probe failed: ' + icErr.message);
                        cachedImageCapture = null;
                    }
                }

                setupFlashButton(track);
            } catch (constraintErr) {
                _logger.warn('Could not apply advanced constraints: ' + constraintErr.message);
            }

            const settings = track.getSettings();
            _logger.info(`Camera resolution: ${settings.width}x${settings.height}`);

            video.addEventListener('loadeddata', () => {
                container.scrollIntoView({ behavior: 'smooth', block: 'start' });
                if (detectEnabled) startDetectionLoop();
            }, { once: true });
            return true;
        } catch (e) {
            _logger.error('Failed to start camera: ' + e.message);
            _showToast(_i18n.t('send.cameraFailed'));
            return false;
        }
    }

    function setupFlashButton(track) {
        const btn = document.getElementById('flash-toggle-btn');
        btn.classList.remove('hidden');
        if (!torchSupported && !fillLightSupported) {
            btn.disabled = true;
            btn.title = _i18n.t('send.flashUnsupportedReason');
            document.getElementById('flash-icon').textContent = '⚡';
            document.getElementById('flash-label').textContent = _i18n.t('send.flashOff');
            try {
                const caps = track.getCapabilities ? track.getCapabilities() : {};
                const settings = track.getSettings();
                _logger.info('Flash unavailable — device diagnostics:');
                _logger.info('  Track label: ' + track.label);
                _logger.info('  Facing mode: ' + (settings.facingMode || 'unknown'));
                _logger.info('  Torch capability: ' + JSON.stringify(caps.torch));
                _logger.info('  ImageCapture API: ' + (typeof ImageCapture !== 'undefined' ? 'available' : 'not available'));
                _logger.info('  All capabilities: ' + JSON.stringify(caps));
            } catch (diagErr) {
                _logger.info('Flash diagnostics failed: ' + diagErr.message);
            }
            return;
        }
        if (!torchSupported && flashMode === 'torch') {
            flashMode = 'flash';
        }
        updateFlashUI();
        if (flashMode === 'torch') {
            track.applyConstraints({ advanced: [{ torch: true }] });
        }
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => cycleFlashMode(track));
    }

    function cycleFlashMode(track) {
        const modes = torchSupported ? ['off', 'torch', 'flash'] : ['off', 'flash'];
        const idx = modes.indexOf(flashMode);
        flashMode = modes[(idx + 1) % modes.length];
        _logger.info('Flash mode: ' + flashMode);

        if (flashMode === 'torch') {
            track.applyConstraints({ advanced: [{ torch: true }] });
        } else {
            track.applyConstraints({ advanced: [{ torch: false }] });
        }
        updateFlashUI();
    }

    function updateFlashUI() {
        const btn = document.getElementById('flash-toggle-btn');
        const icon = document.getElementById('flash-icon');
        const label = document.getElementById('flash-label');
        if (flashMode === 'off') {
            icon.textContent = '⚡';
            label.textContent = _i18n.t('send.flashOff');
            btn.classList.remove('flash-active');
        } else if (flashMode === 'torch') {
            icon.textContent = '🔦';
            label.textContent = _i18n.t('send.flashTorch');
            btn.classList.add('flash-active');
        } else {
            icon.textContent = '⚡';
            label.textContent = _i18n.t('send.flashAuto');
            btn.classList.add('flash-active');
        }
    }

    // ============ Document Detection ============

    function setupDetectButton() {
        const btn = document.getElementById('detect-toggle-btn');
        updateDetectUI();
        btn.addEventListener('click', () => {
            detectEnabled = !detectEnabled;
            localStorage.setItem('docDetectEnabled', String(detectEnabled));
            updateDetectUI();
            if (detectEnabled && captureStream) {
                startDetectionLoop();
            } else {
                stopDetectionLoop();
            }
        });
    }

    function updateDetectUI() {
        const btn = document.getElementById('detect-toggle-btn');
        const label = document.getElementById('detect-label');
        if (detectEnabled) {
            btn.classList.add('detect-active');
            label.textContent = _i18n.t('send.detectOn');
        } else {
            btn.classList.remove('detect-active');
            label.textContent = _i18n.t('send.detectOff');
        }
    }

    function startDetectionLoop() {
        stopDetectionLoop();
        const video = document.getElementById('capture-video');
        const overlay = document.getElementById('detect-overlay');
        overlay.classList.remove('hidden');
        detectInterval = setInterval(() => {
            if (!captureStream || video.readyState < 2) return;
            const result = window.DocDetect.detectFromVideo(video);
            const polygon = document.getElementById('detect-polygon');
            if (result) {
                lastDetectedCorners = result;
                const w = video.clientWidth, h = video.clientHeight;
                const pts = [result.tl, result.tr, result.br, result.bl]
                    .map(p => `${(p.x * w).toFixed(1)},${(p.y * h).toFixed(1)}`)
                    .join(' ');
                polygon.setAttribute('points', pts);
                overlay.classList.remove('hidden');
            } else {
                lastDetectedCorners = null;
                overlay.classList.add('hidden');
            }
        }, 1000);
    }

    function stopDetectionLoop() {
        if (detectInterval) {
            clearInterval(detectInterval);
            detectInterval = null;
        }
        document.getElementById('detect-overlay').classList.add('hidden');
    }

    function stopCapture() {
        stopDetectionLoop();
        const video = document.getElementById('capture-video');
        const container = video.parentElement;
        if (captureStream) {
            captureStream.getTracks().forEach(track => track.stop());
            captureStream = null;
        }
        video.srcObject = null;
        container.classList.remove('active');
        resetCameraZoom(video);
        // flashMode is intentionally NOT reset — persists across photos
        const flashBtn = document.getElementById('flash-toggle-btn');
        if (flashBtn) flashBtn.classList.add('hidden');
        cachedImageCapture = null;
    }

    async function capturePhoto() {
        const video = document.getElementById('capture-video');
        const canvas = document.getElementById('capture-canvas');
        const track = captureStream ? captureStream.getVideoTracks()[0] : null;

        let capturedBlob = null;
        if (flashMode === 'flash' && track) {
            if (torchSupported) {
                try {
                    await track.applyConstraints({ advanced: [{ torch: true }] });
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (e) {
                    _logger.warn('Flash fire failed: ' + e.message);
                    _showToast(_i18n.t('send.flashFallbackNoFlash'), { duration: 3000 });
                }
            } else if (fillLightSupported && cachedImageCapture) {
                try {
                    capturedBlob = await cachedImageCapture.takePhoto({ fillLightMode: 'flash' });
                    _logger.info(`Captured photo via ImageCapture with flash, ${(capturedBlob.size / 1024).toFixed(0)} KB`);
                } catch (e) {
                    _logger.warn('ImageCapture flash failed, falling back to canvas: ' + e.message);
                    _showToast(_i18n.t('send.flashFallbackNoFlash'), { duration: 3000 });
                }
            }
        }

        if (!capturedBlob) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0);

            if (flashMode === 'flash' && track && torchSupported) {
                track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
            }

            capturedBlob = await new Promise(resolve =>
                canvas.toBlob(resolve, 'image/jpeg', 0.95)
            );
            _logger.info(`Captured photo: ${video.videoWidth}x${video.videoHeight}, ${(capturedBlob.size / 1024).toFixed(0)} KB`);
        }

        // Brief visual feedback: flash the screen white
        const container = document.getElementById('capture-camera-container');
        container.style.boxShadow = 'inset 0 0 0 1000px rgba(255,255,255,0.5)';
        setTimeout(() => { container.style.boxShadow = ''; }, 120);

        if (_onPhotoCaptured) _onPhotoCaptured(capturedBlob);
    }

    // ============ Pinch to Zoom ============

    function setupPinchZoom(video) {
        const container = video.parentElement;

        container.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                lastPinchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
        }, { passive: false });

        container.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && video.srcObject) {
                e.preventDefault();
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                if (lastPinchDist > 0) {
                    cameraZoom *= dist / lastPinchDist;
                    cameraZoom = Math.max(1, Math.min(5, cameraZoom));
                    video.style.transform = `scale(${cameraZoom})`;
                }
                lastPinchDist = dist;
            }
        }, { passive: false });

        container.addEventListener('touchend', () => {
            lastPinchDist = 0;
        });
    }

    function resetCameraZoom(video) {
        cameraZoom = 1;
        video.style.transform = '';
    }

    // ============ Visibility / cleanup helpers ============

    function suspendTorch() {
        if (flashMode === 'torch' && captureStream) {
            const track = captureStream.getVideoTracks()[0];
            if (track) {
                track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
            }
        }
    }

    function resumeTorch() {
        if (flashMode === 'torch' && captureStream) {
            const track = captureStream.getVideoTracks()[0];
            if (track) {
                track.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
            }
        }
    }

    function cleanup() {
        stopDetectionLoop();
        if (scannerStream) {
            scannerStream.getTracks().forEach(t => t.stop());
            scannerStream = null;
        }
        if (captureStream) {
            captureStream.getTracks().forEach(t => t.stop());
            captureStream = null;
        }
        cachedImageCapture = null;
    }

    /** Read+clear last detected corners (used by orchestrator's openCropModal). */
    function consumeDetectedCorners() {
        const c = lastDetectedCorners;
        lastDetectedCorners = null;
        return c;
    }

    window.SenderCamera = {
        attach,
        startScanner,
        stopScanner,
        startCapture,
        stopCapture,
        capturePhoto,
        suspendTorch,
        resumeTorch,
        cleanup,
        getFlashMode: () => flashMode,
        getCaptureStream: () => captureStream,
        consumeDetectedCorners,
    };
})();
