// GC-ATLAS — zonal-mean cross-section panel.
// For pressure-level fields: lat × pressure heatmap (log-p axis, pole-to-pole).
// For surface fields: lat line plot.
// Renders into a plain <canvas> — no D3 dependency.

import { getField, LEVELS, GRID, FIELDS } from './data.js';
import { sample } from './colormap.js';

const LAT_TICKS = [-90, -60, -30, 0, 30, 60, 90];
const P_TICKS   = [1000, 500, 200, 100, 50, 10];

/**
 * Compute the zonal-mean field.
 * Returns:
 *   pl fields → { type:'pl', values: Float32Array(nlev*nlat), levels, vmin, vmax, name, units }
 *   sl fields → { type:'sl', values: Float32Array(nlat),       vmin, vmax, name, units }
 */
export function computeZonalMean(fieldName, month) {
    const meta = FIELDS[fieldName];
    const { nlat, nlon } = GRID;

    if (meta.type === 'sl') {
        const f = getField(fieldName, { month });
        const zm = new Float32Array(nlat);
        let vmin = Infinity, vmax = -Infinity;
        for (let i = 0; i < nlat; i++) {
            let s = 0;
            for (let j = 0; j < nlon; j++) s += f.values[i * nlon + j];
            const m = s / nlon;
            zm[i] = m;
            if (m < vmin) vmin = m;
            if (m > vmax) vmax = m;
        }
        return { type: 'sl', values: zm, vmin, vmax, name: meta.name, units: meta.units };
    }

    const nlev = LEVELS.length;
    const zm = new Float32Array(nlev * nlat);
    let vmin = Infinity, vmax = -Infinity;
    for (let k = 0; k < nlev; k++) {
        const f = getField(fieldName, { month, level: LEVELS[k] });
        for (let i = 0; i < nlat; i++) {
            let s = 0;
            for (let j = 0; j < nlon; j++) s += f.values[i * nlon + j];
            const m = s / nlon;
            zm[k * nlat + i] = m;
            if (m < vmin) vmin = m;
            if (m > vmax) vmax = m;
        }
    }
    return { type: 'pl', values: zm, vmin, vmax, levels: LEVELS.slice(),
             name: meta.name, units: meta.units };
}

export function renderCrossSection(canvas, zm, cmap) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const padL = 42, padR = 10, padT = 10, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    if (zm.type === 'pl') {
        drawHeatmap(ctx, padL, padT, plotW, plotH, zm, cmap);
    } else {
        drawLine(ctx, padL, padT, plotW, plotH, zm);
    }
    drawAxes(ctx, padL, padT, plotW, plotH, zm);
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

            const t = (v - vmin) / span;
            const [r, g, b] = sample(cmap, t);
            const k = (py * iw + px) * 4;
            data[k]     = r * 255;
            data[k + 1] = g * 255;
            data[k + 2] = b * 255;
            data[k + 3] = 255;
        }
    }
    ctx.putImageData(img, x0, y0);

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
}

function drawLine(ctx, x0, y0, w, h, zm) {
    const { values, vmin, vmax } = zm;
    const { nlat } = GRID;
    const span = (vmax - vmin) || 1;

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);

    ctx.strokeStyle = '#2DBDA0';
    ctx.lineWidth = 2;
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
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillStyle = '#AEC3B6';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const lat of LAT_TICKS) {
        const x = x0 + ((lat + 90) / 180) * w;
        ctx.beginPath();
        ctx.moveTo(x, y0 + h);
        ctx.lineTo(x, y0 + h + 3);
        ctx.stroke();
        ctx.fillText(`${lat}°`, x, y0 + h + 5);
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
            ctx.moveTo(x0 - 3, y);
            ctx.lineTo(x0, y);
            ctx.stroke();
            ctx.fillText(`${p}`, x0 - 5, y);
        }
        ctx.save();
        ctx.translate(x0 - 30, y0 + h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText('hPa', 0, 0);
        ctx.restore();
    } else {
        ctx.fillText(zm.vmax.toFixed(0), x0 - 5, y0 + 4);
        ctx.fillText(zm.vmin.toFixed(0), x0 - 5, y0 + h - 4);
    }
}
