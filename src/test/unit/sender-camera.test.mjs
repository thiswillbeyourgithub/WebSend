/**
 * Unit tests for js/sender-camera.js — focused on capturePhoto()'s debounce.
 *
 * Regression: tapping the capture button while a capture (and its full-res JPEG
 * encode) is still in flight used to grab a fresh frame per tap and silently
 * produce duplicate photos. Because the encode has no immediate on-screen
 * feedback, users tapped repeatedly thinking it hadn't registered. capturePhoto()
 * now self-debounces via a `capturing` flag; this test locks that in.
 *
 * Camera start, flash, detection overlay and pinch-zoom are out of scope here
 * (they need getUserMedia / real video frames and live in E2E / manual testing).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/sender-camera.js');
const moduleSource = readFileSync(modulePath, 'utf8');

/**
 * Load sender-camera.js into a jsdom window wired with just enough DOM +
 * globals for capturePhoto() to run: the capture container/video/canvas, the
 * elements attach() touches, a controllable requestAnimationFrame, and a canvas
 * whose getContext/toBlob are stubbed (jsdom has no real canvas backend).
 * Returns { win, rafQueue, captured, deps }.
 */
function loadCamera() {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="capture-camera-container">
            <video id="capture-video"></video>
            <canvas id="capture-canvas"></canvas>
        </div>
        <video id="scanner-video"></video>
        <button id="detect-toggle-btn"></button>
        <span id="detect-label"></span>
    </body></html>`, { runScripts: 'outside-only', url: 'http://localhost/' });

    const win = dom.window;

    // Controllable rAF: capturePhoto() yields two frames (nextFramePaint) before
    // doing any heavy work, so the shutter flash paints first. Queue the
    // callbacks and drive them from the test.
    const rafQueue = [];
    win.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };

    // Stub the canvas: jsdom's getContext returns null and toBlob throws.
    const canvasEl = win.document.getElementById('capture-canvas');
    canvasEl.getContext = () => ({ drawImage() {} });
    canvasEl.toBlob = (cb) => cb(new win.Blob(['jpeg-bytes'], { type: 'image/jpeg' }));

    const videoEl = win.document.getElementById('capture-video');
    Object.defineProperty(videoEl, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(videoEl, 'videoHeight', { value: 480, configurable: true });

    win.eval(moduleSource);

    const captured = [];
    const deps = {
        getRtc: () => null,
        i18n: { t: () => '' },
        logger: { info() {}, warn() {}, error() {}, success() {} },
        showToast: () => {},
        onPhotoCaptured: (blob) => { captured.push(blob); },
    };
    win.SenderCamera.attach(deps);

    return { win, rafQueue, captured };
}

/** Alternate flushing queued rAF callbacks with microtask yields until idle. */
async function runToIdle(rafQueue) {
    for (let i = 0; i < 20; i++) {
        if (rafQueue.length) {
            const cbs = rafQueue.splice(0);
            for (const cb of cbs) cb();
        }
        await Promise.resolve();
    }
}

test('capturePhoto: rapid double-tap only captures once (debounce)', async () => {
    const { win, rafQueue, captured } = loadCamera();

    // Two taps back to back, before the first has finished encoding.
    const p1 = win.SenderCamera.capturePhoto();
    const p2 = win.SenderCamera.capturePhoto();
    await runToIdle(rafQueue);
    await p1;
    await p2;

    assert.equal(captured.length, 1, 'only one photo despite two rapid taps');
});

test('capturePhoto: single tap produces exactly one photo blob', async () => {
    const { win, rafQueue, captured } = loadCamera();

    const p = win.SenderCamera.capturePhoto();
    await runToIdle(rafQueue);
    await p;

    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, 'image/jpeg');
});

test('capturePhoto: debounce releases so a later capture still works', async () => {
    const { win, rafQueue, captured } = loadCamera();

    const p1 = win.SenderCamera.capturePhoto();
    await runToIdle(rafQueue);
    await p1;

    // A fresh tap after the first fully settled must not be swallowed.
    const p2 = win.SenderCamera.capturePhoto();
    await runToIdle(rafQueue);
    await p2;

    assert.equal(captured.length, 2, 'capturing flag reset lets the next tap through');
});

test('capturePhoto: shutter flash is applied immediately, before the encode', async () => {
    const { win, rafQueue } = loadCamera();
    const container = win.document.getElementById('capture-camera-container');

    const p = win.SenderCamera.capturePhoto();
    // No rAF has been driven yet: the encode hasn't run, but the flash must
    // already be on screen (that is the whole point of the responsiveness fix).
    assert.match(container.style.boxShadow, /rgba\(255,\s*255,\s*255/,
        'shutter flash set synchronously on tap');

    await runToIdle(rafQueue);
    await p;
});
