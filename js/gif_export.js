// GC-ATLAS — GIF exporter.
//
// Captures the live WebGL canvas frame-by-frame and encodes to an animated
// GIF via gifenc (~8 kB, Web-Worker-friendly palette quantisation).
//
// Two capture modes:
//   • 'animated' — grabs N frames over `durationMs` at the current month so
//     the wind-particle animation + any diurnal rotation show up. User stays
//     still; capture just reads the already-running render loop.
//   • 'annual'   — steps month 1..12, waits for each month's tiles to land,
//     renders, captures once per month. Produces a 12-frame seasonal loop.
//
// Output is a Blob the caller downloads as a .gif.

import { GIFEncoder, quantize, applyPalette } from 'https://unpkg.com/gifenc@1.0.3/dist/gifenc.esm.js';

const DEFAULT_FPS = 15;
const CAPTURE_MAX_WIDTH = 900;   // downscale to keep file size reasonable

export class GifExporter {
    /** app: { renderer, state, setState, updateField, getIsReady } */
    constructor(app) {
        this.app = app;
    }

    /** Grab the current renderer canvas into an ImageData. Downscales to
     *  `maxWidth` so 4K monitors don't blow the file size. */
    _captureFrame(maxWidth = CAPTURE_MAX_WIDTH) {
        const src = this.app.renderer.domElement;
        const srcW = src.width;
        const srcH = src.height;
        const scale = Math.min(1, maxWidth / srcW);
        const w = Math.round(srcW * scale);
        const h = Math.round(srcH * scale);
        const cap = document.createElement('canvas');
        cap.width = w;
        cap.height = h;
        const ctx = cap.getContext('2d');
        // Fill a dark background so alpha regions don't look patchy in GIF.
        ctx.fillStyle = '#0a1a18';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(src, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
    }

    async _rafDelay(ms) {
        const end = performance.now() + ms;
        while (performance.now() < end) {
            await new Promise(r => requestAnimationFrame(r));
        }
    }

    /** Capture mode = 'animated': N frames at `fps` over `durationMs`. */
    async captureAnimated({ durationMs = 5000, fps = DEFAULT_FPS, onProgress } = {}) {
        const nFrames = Math.max(2, Math.round(durationMs * fps / 1000));
        const perFrameMs = 1000 / fps;
        const imgs = [];
        for (let i = 0; i < nFrames; i++) {
            await this._rafDelay(perFrameMs);
            imgs.push(this._captureFrame());
            onProgress?.(i + 1, nFrames);
        }
        return this._encode(imgs, perFrameMs);
    }

    /** Capture mode = 'annual': step months 1..12 and capture one frame per
     *  month. Waits up to 3 s per month for tiles to finish loading. */
    async captureAnnual({ frameDelayMs = 220, onProgress } = {}) {
        const priorMonth = this.app.state.month;
        const imgs = [];
        const months = [1,2,3,4,5,6,7,8,9,10,11,12];
        for (let i = 0; i < months.length; i++) {
            const m = months[i];
            this.app.setState({ month: m });
            // Wait for tiles.
            const t0 = performance.now();
            while (!this.app.getIsReady() && performance.now() - t0 < 3000) {
                await new Promise(r => setTimeout(r, 40));
            }
            // Two render frames so contours / decomposition settle.
            await this._rafDelay(100);
            imgs.push(this._captureFrame());
            onProgress?.(i + 1, months.length);
        }
        // Restore.
        this.app.setState({ month: priorMonth });
        return this._encode(imgs, frameDelayMs);
    }

    /** Encode ImageData[] → GIF Blob. */
    _encode(imgs, frameDelayMs) {
        const gif = GIFEncoder();
        for (const img of imgs) {
            const data = img.data;
            const palette = quantize(data, 256);
            const indexed = applyPalette(data, palette);
            gif.writeFrame(indexed, img.width, img.height, {
                palette, delay: Math.round(frameDelayMs),
            });
        }
        gif.finish();
        return new Blob([gif.bytes()], { type: 'image/gif' });
    }
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
}
