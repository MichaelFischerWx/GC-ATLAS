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
import { FIELDS } from './data.js';

const DEFAULT_FPS = 15;
const CAPTURE_MAX_WIDTH = 900;   // downscale to keep file size reasonable
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export class GifExporter {
    /** app: { renderer, state, setState, updateField, getIsReady } */
    constructor(app) {
        this.app = app;
    }

    /** Build the caption strings from current app state. Rebuilt each
     *  frame so the annual loop's month label advances per-frame and any
     *  composite / year / climatology context is always current. */
    _buildCaption() {
        const s = this.app.state;
        const meta = FIELDS[s.field] || {};
        let title = meta.name || s.field;
        if (meta.type === 'pl') {
            title += s.vCoord === 'theta'
                ? ` · θ=${s.theta} K`
                : ` · ${s.level} hPa`;
        }
        if (s.kind === 'std') {
            title += ' · ±1σ';
        } else if (s.decompose && s.decompose !== 'total') {
            title += ` · ${s.decompose}`;
        }

        const subParts = [MONTHS[s.month - 1]];
        const cr = s.customRange;
        // Describe what's painted on the left half (the "active" view).
        let leftLabel;
        if (s.year != null) {
            leftLabel = String(s.year);
        } else if (cr && cr.label) {
            const n = Array.isArray(cr.years) ? cr.years.length : 0;
            leftLabel = `${cr.label}${n ? ` · ${n} events` : ''}`;
        } else if (cr && Number.isFinite(cr.start) && Number.isFinite(cr.end)) {
            leftLabel = `${cr.start}–${cr.end} mean`;
        } else if (s.climatologyPeriod && s.climatologyPeriod !== 'default') {
            leftLabel = s.climatologyPeriod;
        } else {
            leftLabel = '1991–2020';
        }
        // In compare mode, identify the right-half target too so the GIF's
        // caption reads correctly as the swipe divider sweeps and viewers
        // see more of the right-hand painted region.
        if (s.compareMode) {
            let rightLabel = null;
            if (s.compareYear != null) {
                rightLabel = String(s.compareYear);
            } else if (s.referencePeriod && s.referencePeriod !== 'default'
                       && s.referencePeriod !== s.climatologyPeriod) {
                rightLabel = s.referencePeriod;
            }
            if (rightLabel) {
                subParts.push(`${leftLabel} ⇄ ${rightLabel}`);
            } else {
                subParts.push(leftLabel);
            }
        } else {
            subParts.push(leftLabel);
            if (s.decompose === 'anomaly'
                && s.referencePeriod && s.referencePeriod !== 'default'
                && s.referencePeriod !== s.climatologyPeriod) {
                subParts.push(`vs ${s.referencePeriod}`);
            }
        }
        return { title, sub: subParts.join(' · ') };
    }

    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    /** Paint the caption ribbon onto the capture canvas (top-left). */
    _drawCaption(ctx) {
        const { title, sub } = this._buildCaption();
        const padX = 10, padY = 8;
        const lineHTitle = 18;
        const lineHSub   = 15;
        const fontTitle  = 'bold 14px ui-monospace, "JetBrains Mono", Menlo, monospace';
        const fontSub    = '12px ui-monospace, "JetBrains Mono", Menlo, monospace';

        ctx.font = fontTitle;
        const wTitle = ctx.measureText(title).width;
        ctx.font = fontSub;
        const wSub = ctx.measureText(sub).width;
        const boxW = Math.ceil(Math.max(wTitle, wSub)) + 2 * padX;
        const boxH = padY * 2 + lineHTitle + lineHSub + 2;

        ctx.save();
        ctx.fillStyle = 'rgba(6, 16, 14, 0.78)';
        ctx.strokeStyle = 'rgba(139, 176, 161, 0.35)';
        ctx.lineWidth = 1;
        this._roundRect(ctx, 12, 12, boxW, boxH, 5);
        ctx.fill();
        ctx.stroke();

        ctx.textBaseline = 'top';
        ctx.font = fontTitle;
        ctx.fillStyle = '#f0f6f2';
        ctx.fillText(title, 12 + padX, 12 + padY);
        ctx.font = fontSub;
        ctx.fillStyle = '#8bb0a1';
        ctx.fillText(sub, 12 + padX, 12 + padY + lineHTitle + 2);
        ctx.restore();
    }

    /** Grab the current renderer canvas into an ImageData. Downscales to
     *  `maxWidth` so 4K monitors don't blow the file size. Overlays a
     *  caption ribbon with field / level / time context so the exported
     *  GIF is self-describing. */
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
        this._drawCaption(ctx);
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

    /** Capture mode = 'swipe-sweep': step compareSplit from 0.02 to 0.98
     *  in 36 evenly-spaced frames (10° each over 360° of the map).
     *  Requires compareMode=true + map view. The divider slides W → E,
     *  exposing more of the right-half (reference period / year) as it
     *  advances. Restores the original split at the end. */
    async captureSwipeSweep({ frameDelayMs = 120, nFrames = 36, onProgress } = {}) {
        const app = this.app;
        if (!app.state.compareMode || app.state.viewMode !== 'map') {
            throw new Error('Compare swipe sweep requires Map view with Compare enabled.');
        }
        const priorSplit = app.state.compareSplit;
        const imgs = [];
        for (let i = 0; i < nFrames; i++) {
            // Cover the full 0.02–0.98 span (matches applyCompareSplit's
            // clamp) so the divider really sweeps edge-to-edge.
            const s = 0.02 + (i / (nFrames - 1)) * (0.98 - 0.02);
            app.setState({ compareSplit: s });
            // Two rAF cycles so the clip plane + split-line updates settle
            // before we grab the pixels.
            await this._rafDelay(40);
            imgs.push(this._captureFrame());
            onProgress?.(i + 1, nFrames);
        }
        app.setState({ compareSplit: priorSplit });
        return this._encode(imgs, frameDelayMs);
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

    /** Encode ImageData[] → GIF Blob.
     *
     *  Uses a single GLOBAL palette derived from all frames combined,
     *  rather than quantizing each frame independently. Per-frame
     *  quantization makes smooth gradients (like our colormap ramps)
     *  flicker between adjacent frames — particularly visible in the
     *  swipe-sweep mode where only the clip boundary changes between
     *  frames. One global palette keeps colors identical across the
     *  whole loop. Costs: a few hundred ms extra encode time and one
     *  combined buffer allocation (~50 MB for a 36-frame swipe). */
    _encode(imgs, frameDelayMs) {
        const gif = GIFEncoder();
        // Build a single concatenated RGBA sample to quantize from.
        // For a 36-frame × 900 × 400 × 4 sweep this is ~52 MB; modern
        // browsers handle it comfortably, and the allocation releases
        // as soon as applyPalette wraps up.
        let total = 0;
        for (const img of imgs) total += img.data.length;
        const combined = new Uint8ClampedArray(total);
        let off = 0;
        for (const img of imgs) {
            combined.set(img.data, off);
            off += img.data.length;
        }
        const palette = quantize(combined, 256);
        for (const img of imgs) {
            const indexed = applyPalette(img.data, palette);
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
