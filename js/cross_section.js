// GC-ATLAS — cross-section panel.
// Two modes:
//   zonal:  zonal-mean over all longitudes at each latitude (the original
//           "lat × pressure" heatmap, pole-to-pole).
//   arc:    vertical section along a user-drawn great circle on the globe.
// Renders into a plain <canvas> — no D3 dependency.

import { getField, LEVELS, GRID, FIELDS } from './data.js';
import { sample } from './colormap.js';
import { gcDistanceKm } from './arc.js';

const LAT_TICKS = [-90, -60, -30, 0, 30, 60, 90];
const P_TICKS   = [1000, 500, 200, 100, 50, 10];

/**
 * Zonal mean — NaN-aware average at each latitude.
 * Returns { kind:'zonal', type, values, vmin, vmax, ... }.
 */
export function computeZonalMean(fieldName, month) {
    const meta = FIELDS[fieldName];
    const { nlat, nlon } = GRID;

    if (meta.type === 'sl') {
        const f = getField(fieldName, { month });
        const zm = new Float32Array(nlat);
        let vmin = Infinity, vmax = -Infinity;
        for (let i = 0; i < nlat; i++) {
            let s = 0, n = 0;
            for (let j = 0; j < nlon; j++) {
                const v = f.values[i * nlon + j];
                if (Number.isFinite(v)) { s += v; n += 1; }
            }
            const m = n > 0 ? s / n : NaN;
            zm[i] = m;
            if (Number.isFinite(m)) {
                if (m < vmin) vmin = m;
                if (m > vmax) vmax = m;
            }
        }
        if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
        return { kind: 'zonal', type: 'sl', values: zm, vmin, vmax,
                 name: meta.name, units: meta.units };
    }

    const nlev = LEVELS.length;
    const zm = new Float32Array(nlev * nlat);
    let vmin = Infinity, vmax = -Infinity;
    for (let k = 0; k < nlev; k++) {
        const f = getField(fieldName, { month, level: LEVELS[k] });
        for (let i = 0; i < nlat; i++) {
            let s = 0, n = 0;
            for (let j = 0; j < nlon; j++) {
                const v = f.values[i * nlon + j];
                if (Number.isFinite(v)) { s += v; n += 1; }
            }
            const m = n > 0 ? s / n : NaN;
            zm[k * nlat + i] = m;
            if (Number.isFinite(m)) {
                if (m < vmin) vmin = m;
                if (m > vmax) vmax = m;
            }
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    return { kind: 'zonal', type: 'pl', values: zm, vmin, vmax,
             levels: LEVELS.slice(), name: meta.name, units: meta.units };
}

/** Bilinear sample of a (nlat × nlon) field at arbitrary (lat, lon). NaN-safe. */
function bilinearSample(values, lat, lon) {
    const { nlat, nlon } = GRID;
    const rLat = 90 - lat;
    const rLon = ((lon + 180) % 360 + 360) % 360;
    if (rLat < 0 || rLat > nlat - 1) return NaN;
    const i0 = Math.max(0, Math.min(nlat - 1, Math.floor(rLat)));
    const i1 = Math.max(0, Math.min(nlat - 1, i0 + 1));
    const j0 = Math.floor(rLon) % nlon;
    const j1 = (j0 + 1) % nlon;
    const fi = rLat - i0;
    const fj = rLon - Math.floor(rLon);
    const v00 = values[i0 * nlon + j0];
    const v01 = values[i0 * nlon + j1];
    const v10 = values[i1 * nlon + j0];
    const v11 = values[i1 * nlon + j1];
    // If any corner is NaN, fall back to mean of finite corners.
    const anyNaN = !Number.isFinite(v00) || !Number.isFinite(v01)
                || !Number.isFinite(v10) || !Number.isFinite(v11);
    if (anyNaN) {
        let s = 0, n = 0;
        for (const v of [v00, v01, v10, v11]) if (Number.isFinite(v)) { s += v; n += 1; }
        return n > 0 ? s / n : NaN;
    }
    const vT = v00 * (1 - fj) + v01 * fj;
    const vB = v10 * (1 - fj) + v11 * fj;
    return vT * (1 - fi) + vB * fi;
}

/**
 * Cross-section along an arc (array of { lat, lon } points).
 * Returns { kind:'arc', type, values, vmin, vmax, nSamples, arc, distanceKm, ... }.
 * For pressure-level fields, values is Float32Array(nlev × nSamples).
 * For single-level fields, values is Float32Array(nSamples).
 */
export function computeArcCrossSection(fieldName, month, arc) {
    const meta = FIELDS[fieldName];
    const nSamples = arc.length;
    if (nSamples < 2) return null;
    const distanceKm = gcDistanceKm(
        arc[0].lat, arc[0].lon, arc[arc.length - 1].lat, arc[arc.length - 1].lon,
    );

    if (meta.type === 'sl') {
        const f = getField(fieldName, { month });
        const values = new Float32Array(nSamples);
        let vmin = Infinity, vmax = -Infinity;
        for (let j = 0; j < nSamples; j++) {
            const v = bilinearSample(f.values, arc[j].lat, arc[j].lon);
            values[j] = v;
            if (Number.isFinite(v)) {
                if (v < vmin) vmin = v;
                if (v > vmax) vmax = v;
            }
        }
        if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
        return { kind: 'arc', type: 'sl', values, vmin, vmax,
                 nSamples, arc, distanceKm, name: meta.name, units: meta.units };
    }

    const nlev = LEVELS.length;
    const values = new Float32Array(nlev * nSamples);
    let vmin = Infinity, vmax = -Infinity;
    for (let k = 0; k < nlev; k++) {
        const f = getField(fieldName, { month, level: LEVELS[k] });
        for (let j = 0; j < nSamples; j++) {
            const v = bilinearSample(f.values, arc[j].lat, arc[j].lon);
            values[k * nSamples + j] = v;
            if (Number.isFinite(v)) {
                if (v < vmin) vmin = v;
                if (v > vmax) vmax = v;
            }
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    return { kind: 'arc', type: 'pl', values, vmin, vmax,
             nSamples, arc, distanceKm, levels: LEVELS.slice(),
             name: meta.name, units: meta.units };
}

export function renderCrossSection(canvas, zm, cmap) {
    // Retina-aware: size the canvas buffer to DPR × CSS size so text and
    // heatmap pixels stay crisp on high-density displays. All drawing ops
    // below use buffer (physical-pixel) coords, so padding and font sizes
    // scale with DPR to preserve CSS-proportion spacing.
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth  || 380;
    const cssH = canvas.clientHeight || 200;
    if (canvas.width !== cssW * DPR || canvas.height !== cssH * DPR) {
        canvas.width  = cssW * DPR;
        canvas.height = cssH * DPR;
    }
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const padL = 42 * DPR, padR = 10 * DPR, padT = 10 * DPR, padB = 26 * DPR;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // Stash DPR on the zm object so the draw fns can scale fonts + strokes.
    zm._dpr = DPR;

    if (zm.kind === 'arc') {
        if (zm.type === 'pl') drawArcHeatmap(ctx, padL, padT, plotW, plotH, zm, cmap);
        else                  drawArcLine   (ctx, padL, padT, plotW, plotH, zm);
        drawArcAxes(ctx, padL, padT, plotW, plotH, zm);
    } else {
        if (zm.type === 'pl') drawHeatmap(ctx, padL, padT, plotW, plotH, zm, cmap);
        else                  drawLine   (ctx, padL, padT, plotW, plotH, zm);
        drawAxes(ctx, padL, padT, plotW, plotH, zm);
    }
}

function drawArcHeatmap(ctx, x0, y0, w, h, zm, cmap) {
    const { values, vmin, vmax, levels, nSamples } = zm;
    const nlev = levels.length;
    const pMax = levels[nlev - 1];
    const pMin = levels[0];
    const logSpan = Math.log(pMax / pMin);
    const span = (vmax - vmin) || 1;

    const iw = Math.floor(w), ih = Math.floor(h);
    const img = ctx.createImageData(iw, ih);
    const data = img.data;

    for (let py = 0; py < ih; py++) {
        const p = pMin * Math.exp((py / (ih - 1)) * logSpan);
        let k0 = 0;
        while (k0 < nlev - 1 && levels[k0 + 1] < p) k0++;
        const k1 = Math.min(nlev - 1, k0 + 1);
        const fLev = (k0 === k1) ? 0
            : Math.log(p / levels[k0]) / Math.log(levels[k1] / levels[k0]);
        for (let px = 0; px < iw; px++) {
            const sIdx = (px / (iw - 1)) * (nSamples - 1);
            const j0 = Math.floor(sIdx);
            const j1 = Math.min(nSamples - 1, j0 + 1);
            const fS = sIdx - j0;
            const v00 = values[k0 * nSamples + j0], v01 = values[k0 * nSamples + j1];
            const v10 = values[k1 * nSamples + j0], v11 = values[k1 * nSamples + j1];
            const vT = v00 * (1 - fS) + v01 * fS;
            const vB = v10 * (1 - fS) + v11 * fS;
            const v  = vT * (1 - fLev) + vB * fLev;
            const k = (py * iw + px) * 4;
            if (!Number.isFinite(v)) {
                data[k] = 18; data[k+1] = 26; data[k+2] = 22; data[k+3] = 255;
                continue;
            }
            const t = (v - vmin) / span;
            const [r, g, b] = sample(cmap, t);
            data[k]     = r * 255;
            data[k + 1] = g * 255;
            data[k + 2] = b * 255;
            data[k + 3] = 255;
        }
    }
    ctx.putImageData(img, x0, y0);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = zm._dpr || 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
}

function drawArcLine(ctx, x0, y0, w, h, zm) {
    const { values, vmin, vmax, nSamples } = zm;
    const span = (vmax - vmin) || 1;
    const dpr = zm._dpr || 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = dpr;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);

    ctx.strokeStyle = '#2DBDA0';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    let started = false;
    for (let j = 0; j < nSamples; j++) {
        const v = values[j];
        if (!Number.isFinite(v)) { started = false; continue; }
        const x = x0 + (j / (nSamples - 1)) * w;
        const y = y0 + h - ((v - vmin) / span) * h;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else          ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function drawArcAxes(ctx, x0, y0, w, h, zm) {
    const dpr = zm._dpr || 1;
    ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = '#AEC3B6';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = dpr;

    // Endpoint labels on the x-axis: start / middle / end (lat, lon).
    // Align flush-left / centred / flush-right so the outer labels don't
    // clip against the panel edge.
    const fmtPt = (p) => `${Math.abs(Math.round(p.lat))}°${p.lat >= 0 ? 'N' : 'S'} ${Math.round(p.lon)}°`;
    const ticks = [
        { t: 0.0, label: fmtPt(zm.arc[0]),                         align: 'left'   },
        { t: 0.5, label: fmtPt(zm.arc[Math.floor(zm.arc.length / 2)]), align: 'center' },
        { t: 1.0, label: fmtPt(zm.arc[zm.arc.length - 1]),         align: 'right'  },
    ];
    ctx.textBaseline = 'top';
    for (const { t, label, align } of ticks) {
        const x = x0 + t * w;
        ctx.beginPath();
        ctx.moveTo(x, y0 + h);
        ctx.lineTo(x, y0 + h + 3 * dpr);
        ctx.stroke();
        ctx.textAlign = align;
        ctx.fillText(label, x, y0 + h + 5 * dpr);
    }
    // Distance caption under the middle tick.
    const distTxt = `${Math.round(zm.distanceKm).toLocaleString()} km`;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(174,195,182,0.7)';
    ctx.fillText(distTxt, x0 + w / 2, y0 + h + 22 * dpr);

    // Pressure ticks on the y-axis (pl fields only).
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#AEC3B6';
    if (zm.type === 'pl') {
        const pMax = zm.levels[zm.levels.length - 1];
        const pMin = zm.levels[0];
        const logSpan = Math.log(pMax / pMin);
        for (const p of P_TICKS) {
            if (p < pMin || p > pMax) continue;
            const y = y0 + h * (Math.log(p / pMin) / logSpan);
            ctx.beginPath();
            ctx.moveTo(x0 - 3 * dpr, y);
            ctx.lineTo(x0, y);
            ctx.stroke();
            ctx.fillText(`${p}`, x0 - 5 * dpr, y);
        }
        ctx.save();
        ctx.translate(x0 - 30 * dpr, y0 + h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText('hPa', 0, 0);
        ctx.restore();
    } else {
        ctx.fillText(zm.vmax.toFixed(0), x0 - 5 * dpr, y0 + 4 * dpr);
        ctx.fillText(zm.vmin.toFixed(0), x0 - 5 * dpr, y0 + h - 4 * dpr);
    }
}

function drawHeatmap(ctx, x0, y0, w, h, zm, cmap) {
    const { values, vmin, vmax, levels } = zm;
    const { nlat } = GRID;
    const nlev = levels.length;
    const pMax = levels[nlev - 1];   // largest pressure = surface
    const pMin = levels[0];          // smallest pressure = stratosphere
    const logSpan = Math.log(pMax / pMin);
    const span = (vmax - vmin) || 1;

    const iw = Math.floor(w), ih = Math.floor(h);
    const img = ctx.createImageData(iw, ih);
    const data = img.data;

    // Atmospheric convention: py=0 (top of panel) → low pressure (stratosphere);
    // py=ih-1 (bottom) → high pressure (surface).
    for (let py = 0; py < ih; py++) {
        const p = pMin * Math.exp((py / (ih - 1)) * logSpan);
        // bracket p in the (ascending) levels array
        let k0 = 0;
        while (k0 < nlev - 1 && levels[k0 + 1] < p) k0++;
        const k1 = Math.min(nlev - 1, k0 + 1);
        const fLev = (k0 === k1) ? 0
            : Math.log(p / levels[k0]) / Math.log(levels[k1] / levels[k0]);

        for (let px = 0; px < iw; px++) {
            const lat = -90 + (px / (iw - 1)) * 180;
            const latIdx = 90 - lat;
            const i0 = Math.max(0, Math.min(nlat - 1, Math.floor(latIdx)));
            const i1 = Math.max(0, Math.min(nlat - 1, i0 + 1));
            const fLat = latIdx - i0;

            const v00 = values[k0 * nlat + i0];
            const v01 = values[k0 * nlat + i1];
            const v10 = values[k1 * nlat + i0];
            const v11 = values[k1 * nlat + i1];
            const vT = v00 * (1 - fLat) + v01 * fLat;
            const vB = v10 * (1 - fLat) + v11 * fLat;
            const v  = vT * (1 - fLev) + vB * fLev;

            const k = (py * iw + px) * 4;
            if (!Number.isFinite(v)) {
                // Tile still loading → NaN; paint as no-data instead of
                // crashing downstream sample(cmap, NaN).
                data[k] = 18; data[k+1] = 26; data[k+2] = 22; data[k+3] = 255;
                continue;
            }
            const t = (v - vmin) / span;
            const [r, g, b] = sample(cmap, t);
            data[k]     = r * 255;
            data[k + 1] = g * 255;
            data[k + 2] = b * 255;
            data[k + 3] = 255;
        }
    }
    ctx.putImageData(img, x0, y0);

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = zm._dpr || 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
}

function drawLine(ctx, x0, y0, w, h, zm) {
    const { values, vmin, vmax } = zm;
    const { nlat } = GRID;
    const span = (vmax - vmin) || 1;
    const dpr = zm._dpr || 1;

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = dpr;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);

    ctx.strokeStyle = '#2DBDA0';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        const x = x0 + ((lat + 90) / 180) * w;
        const y = y0 + h - ((values[i] - vmin) / span) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function drawAxes(ctx, x0, y0, w, h, zm) {
    const dpr = zm._dpr || 1;
    ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = '#AEC3B6';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = dpr;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const lat of LAT_TICKS) {
        const x = x0 + ((lat + 90) / 180) * w;
        ctx.beginPath();
        ctx.moveTo(x, y0 + h);
        ctx.lineTo(x, y0 + h + 3 * dpr);
        ctx.stroke();
        ctx.fillText(`${lat}°`, x, y0 + h + 5 * dpr);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    if (zm.type === 'pl') {
        const pMax = zm.levels[zm.levels.length - 1];
        const pMin = zm.levels[0];
        const logSpan = Math.log(pMax / pMin);
        for (const p of P_TICKS) {
            if (p < pMin || p > pMax) continue;
            const y = y0 + h * (Math.log(p / pMin) / logSpan);
            ctx.beginPath();
            ctx.moveTo(x0 - 3 * dpr, y);
            ctx.lineTo(x0, y);
            ctx.stroke();
            ctx.fillText(`${p}`, x0 - 5 * dpr, y);
        }
        ctx.save();
        ctx.translate(x0 - 30 * dpr, y0 + h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText('hPa', 0, 0);
        ctx.restore();
    } else {
        ctx.fillText(zm.vmax.toFixed(0), x0 - 5 * dpr, y0 + 4 * dpr);
        ctx.fillText(zm.vmin.toFixed(0), x0 - 5 * dpr, y0 + h - 4 * dpr);
    }
}
