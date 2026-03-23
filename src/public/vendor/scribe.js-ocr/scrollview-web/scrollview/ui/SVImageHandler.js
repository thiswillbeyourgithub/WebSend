// Disabling eslint rules that would increase differences between Java/JavaScript versions.
/* eslint-disable no-param-reassign */
const browserMode = typeof process === 'undefined';

export class SVImageHandler {
  /**
   * @param {string} imgStr
   */
  static imageStrToBlob(imgStr) {
    const imgData = new Uint8Array(atob(imgStr)
      .split('')
      .map((c) => c.charCodeAt(0)));

    const imgBlob = new Blob([imgData], { type: 'application/octet-stream' });

    return imgBlob;
  }

  /**
  * @param {string} imgStr
  */
  static imageStrToBuffer(imgStr) {
    const imageBuffer = Buffer.from(imgStr, 'base64');

    return imageBuffer;
  }

  /**
   * Handles various image formats, always returns a ImageBitmap.
   *
   * @param {string} img
   * @param {import('canvaskit-wasm').CanvasKit} [CanvasKit] - CanvasKit module. Must be defined if running in Node.js.
   */
  static async readImage(img, CanvasKit) {
    if (img === undefined) throw new Error('Input is undefined');
    if (img === null) throw new Error('Input is null');

    if (browserMode) {
      const imgBlob = this.imageStrToBlob(img);
      const imgBit = await createImageBitmap(imgBlob);
      return imgBit;
    }

    if (CanvasKit === undefined) throw new Error('CanvasKit module must be provided in environments that do not support OffscreenCanvas natively (i.e. Node.js).');

    const imgBuffer = this.imageStrToBuffer(img);
    const imgBit = CanvasKit.MakeImageFromEncoded(imgBuffer);
    return imgBit;
  }
}
