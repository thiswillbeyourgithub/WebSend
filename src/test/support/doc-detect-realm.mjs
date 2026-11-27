/**
 * Loads DocDetect AND ImageTransforms into one browser realm with a minimal
 * document shim. ImageTransforms.perspectiveTransform uses real canvases, so
 * the shim hands out node-canvas canvases. Shared by the doc-detect sample
 * test and the render-doc-detect.mjs debug script.
 *
 * @param {{createCanvas: Function, ImageData: Function}} canvasMod - the `canvas` package
 * @returns {Promise<{DocDetect: object, ImageTransforms: object}>}
 */
import { loadBrowserModule, publicJs } from './load-browser-module.mjs';

export async function loadDocDetectRealm({ createCanvas, ImageData }) {
    const win = await loadBrowserModule(
        [publicJs('doc-detect.js'), publicJs('image-transforms.js')],
        {
            document: { createElement: (t) => t === 'canvas' ? createCanvas(1, 1) : (() => { throw new Error(t); })() },
            ImageData,
        },
        // doc-detect.js declares a top-level `const DocDetect` without
        // attaching it to window.
        { epilogue: 'window.DocDetect = DocDetect;' });
    return { DocDetect: win.DocDetect, ImageTransforms: win.ImageTransforms };
}
