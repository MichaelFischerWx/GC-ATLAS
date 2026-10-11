// GC-ATLAS — cross-section panel.
// Two modes:
//   zonal:  zonal-mean over all longitudes at each latitude (the original
//           "lat × pressure" heatmap, pole-to-pole).
//   arc:    vertical section along a user-drawn great circle on the globe.
// Renders into a plain <canvas> — no D3 dependency.
//
// Below ground. ERA5 fills pressure levels under the surface with
// extrapolated values; pressure-level field sections leave them out, as the
// diagnostics do (air_mask.js). Zonal sections average each level over the
// columns with air at that level and hatch a level with less than a quarter
// of its circle above ground: at 1000 hPa, 50°N in January [T] is 273.6 K
// over the air, 269.6 K with the extrapolations. Arc sections hatch
// everything below the surface pressure along the arc; between the lowest
// level above the ground and the surface the shading interpolates toward
// ERA5's extrapolated value at the next level down. Both wait for the
// surface pressure of the same time slice before drawing the levels.

import { getField, LEVELS, GRID, FIELDS } from './data.js';
import { sample } from './colormap.js';
import { gcDistanceKm, arcPathLengthKm } from './arc.js';
import { airZonalMean, groundCells } from './air_mask.js';

const LAT_TICKS = [-90, -60, -30, 0, 30, 60, 90];
const latLabel = (lat) => lat === 0 ? 'EQ' : `${Math.abs(lat)}°${lat < 0 ? 'S' : 'N'}`;
const P_TICKS   = [1000, 500, 200, 100, 50, 10];
// A troposphere-only section (top at or below 100 hPa) spans one decade; label it more finely.
const pTicksFor = (pMin) => (pMin >= 100 ? [1000, 700, 500, 300, 200, 100] : P_TICKS);

const KAPPA = 0.2854;   // R / c_p, as in data.js's θ cube

/** Symmetric ±displayCap colour range for fields that declare one (PV:
 *  stratospheric values reach hundreds of PVU). */
function capRange(zm, meta) {
    if (!meta.displayCap) return zm;
    const a = Math.min(meta.displayCap, Math.max(Math.abs(zm.vmin), Math.abs(zm.vmax)));
    zm.vmin = -a;
    zm.vmax = a;
    return zm;
}

/** Isentropes for a pressure section in θ coordinates: for each θ in
 *  `thetas`, the pressure where the section's θ = T (1000/p)^κ crosses it in
 *  every column (NaN where the surface is below 1000 hPa or above 10 hPa).
 *  `tempAt(k)` returns the column temperatures at LEVELS[k] — zonal means,
 *  or samples along the arc — or null while T is loading (no overlay yet).
 *  Linear in θ between levels, like the globe's isentropic interpolation.
 *  `floor` (hPa per column, the surface along an arc) ends an isentrope
 *  where it meets the ground. */
function isentropeOverlay(thetas, mark, tempAt, floor = null) {
    const th = [];
    for (let k = 0; k < LEVELS.length; k++) {
        const T = tempAt(k);
        if (!T) return null;
        const f = Math.pow(1000 / LEVELS[k], KAPPA);
        th.push(T.map((v) => v * f));
    }
    const nCols = th[0].length;
    const lines = thetas.map((theta) => {
        const p = new Float32Array(nCols).fill(NaN);
        for (let j = 0; j < nCols; j++) {
            // LEVELS run 10 → 1000 hPa, so θ falls with k.
            for (let k = 0; k < LEVELS.length - 1; k++) {
                const a = th[k][j], b = th[k + 1][j];
                if (Number.isFinite(a) && Number.isFinite(b) && a >= theta && theta > b) {
                    const f = (a - theta) / (a - b);
                    const pc = Math.exp(Math.log(LEVELS[k]) + f * Math.log(LEVELS[k + 1] / LEVELS[k]));
                    p[j] = floor && pc > floor[j] ? NaN : pc;
                    break;
                }
            }
        }
        return { theta, p };
    });
    return { mark, lines };
}

/**
 * Zonal mean — NaN-aware average at each latitude.
 * Returns { kind:'zonal', type, values, vmin, vmax, ... }.
 * `year` / `customRange` select the same time slice as the globe (getField).
 * `isentropes` (θ values, K) adds those isentropes of the same slice, with
 * `markTheta` — the globe's θ surface — drawn bold.
 */
export function computeZonalMean(fieldName, month, { seasonal = false, year = null, customRange = null, isentropes = null, markTheta = null } = {}) {
    const meta = FIELDS[fieldName];
    const { nlat, nlon } = GRID;

    if (meta.type === 'sl') {
        const f = getField(fieldName, { month, seasonal, year, customRange });
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
                 name: meta.name, units: meta.units, slice: f.isReal ? sliceOf(f) : null };
    }

    const nlev = LEVELS.length;
    // Each level averaged over its air (air_mask.js), blank until the
    // surface pressure of the same slice is in.
    const sp = getField('sp', { month, seasonal, year, customRange });
    const SP = sp.isReal ? sp.values : null;
    const zm = new Float32Array(nlev * nlat).fill(NaN);
    let vmin = Infinity, vmax = -Infinity;
    let slice = null;
    for (let k = 0; k < nlev; k++) {
        const f = getField(fieldName, { month, level: LEVELS[k], seasonal, year, customRange });
        if (f.isReal) slice ??= sliceOf(f);
        if (!SP) continue;
        const row = airZonalMean(f.values, SP, LEVELS[k]);
        for (let i = 0; i < nlat; i++) {
            const m = row[i];
            zm[k * nlat + i] = m;
            if (Number.isFinite(m)) {
                if (m < vmin) vmin = m;
                if (m > vmax) vmax = m;
            }
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    const out = capRange({ kind: 'zonal', type: 'pl', values: zm, vmin, vmax,
                           levels: LEVELS.slice(), ground: SP ? groundCells(SP) : null,
                           name: meta.name, units: meta.units, slice }, meta);
    if (isentropes) {
        out.isentropes = isentropeOverlay(isentropes, markTheta, (k) => {
            const t = getField('t', { month, level: LEVELS[k], seasonal, year, customRange });
            return t.isReal && SP ? airZonalMean(t.values, SP, LEVELS[k]) : null;
        });
    }
    return out;
}

/** The time slice getField actually served ({ period, year }), so the panel
 *  title only names a year / composite when the section really shows it. */
function sliceOf(f) {
    return { period: f.period ?? 'default', year: f.year ?? null };
}

/** Sample the cross-section heatmap data at fractional panel coordinates. Used
 *  by the hover tooltip — keeps the inverse mapping in one place. */
/** The part of a zonal pressure section above `pTop` left out: ψ and the
 *  budgets open on the troposphere, EP flux starts below the 10 hPa row it
 *  can't compute. A shallow copy with the levels, values, masks and arrows
 *  trimmed, so drawing and hover read the same grid. */
export function cropSectionTop(zm, pTop) {
    if (!zm || zm.kind !== 'zonal' || zm.type !== 'pl' || !zm.levels) return zm;
    const k0 = zm.levels.findIndex((p) => p >= pTop);
    if (k0 <= 0) return zm;
    const { nlat } = GRID;
    const cut = (a) => (a ? a.slice(k0 * nlat) : a);
    const out = { ...zm, levels: zm.levels.slice(k0), values: cut(zm.values),
                  ground: cut(zm.ground), edge: cut(zm.edge) };
    if (zm.arrows) {
        const keep = [];
        zm.arrows.pressures.forEach((p, i) => { if (p >= pTop) keep.push(i); });
        const pick = (a) => Float32Array.from(keep, (i) => a[i]);
        out.arrows = { ...zm.arrows, lats: pick(zm.arrows.lats),
                       pressures: pick(zm.arrows.pressures),
                       dx: pick(zm.arrows.dx), dy: pick(zm.arrows.dy) };
    }
    return out;
}

export function samplePanel(zm, fracX, fracY) {
    if (!zm) return null;
    if (zm.kind === 'zonal') {
        const lat = -90 + fracX * 180;
        if (zm.type === 'pl') {
            const pMin = zm.levels[0];
            const pMax = zm.levels[zm.levels.length - 1];
            const p = pMin * Math.exp(fracY * Math.log(pMax / pMin));
            const value = sampleZonalPL(zm, lat, p);
            const blank = !Number.isFinite(value);
            return { lat, p, value, ground: blank && onGround(zm, lat, p),
                     edge: blank && onGround(zm, lat, p, zm.edge) };
        }
        return { lat, value: sampleZonalSL(zm, lat) };
    }
    if (zm.kind === 'arc') {
        const sIdx = fracX * (zm.nSamples - 1);
        const j0 = Math.floor(sIdx);
        const j1 = Math.min(zm.nSamples - 1, j0 + 1);
        const fJ = sIdx - j0;
        const a = zm.arc[j0], b = zm.arc[j1];
        const lat = a.lat * (1 - fJ) + b.lat * fJ;
        // Longitude lerp across the dateline needs care; pick the closer wrap.
        let dLon = b.lon - a.lon;
        if (dLon >  180) dLon -= 360;
        if (dLon < -180) dLon += 360;
        let lon = a.lon + dLon * fJ;
        if (lon >  180) lon -= 360;
        if (lon < -180) lon += 360;
        if (zm.type === 'pl') {
            const pMin = zm.levels[0];
            const pMax = zm.levels[zm.levels.length - 1];
            const p = pMin * Math.exp(fracY * Math.log(pMax / pMin));
            const ps = surfaceAt(zm, sIdx);
            const ground = p > ps;
            return { lat, lon, p, ps, ground, value: ground ? NaN : sampleArcPL(zm, sIdx, p) };
        }
        return { lat, lon, value: sampleArcSL(zm, sIdx) };
    }
    return null;
}

function sampleZonalPL(zm, lat, p) {
    const { nlat } = GRID;
    const { values, levels } = zm;
    const nlev = levels.length;
    const rLat = 90 - lat;
    if (rLat < 0 || rLat > nlat - 1) return NaN;
    const i0 = Math.max(0, Math.min(nlat - 1, Math.floor(rLat)));
    const i1 = Math.max(0, Math.min(nlat - 1, i0 + 1));
    const fi = rLat - i0;
    let k0 = 0;
    while (k0 < nlev - 1 && levels[k0 + 1] < p) k0++;
    const k1 = Math.min(nlev - 1, k0 + 1);
    const fK = (k0 === k1) ? 0 : Math.log(p / levels[k0]) / Math.log(levels[k1] / levels[k0]);
    const v00 = values[k0 * nlat + i0], v01 = values[k0 * nlat + i1];
    const v10 = values[k1 * nlat + i0], v11 = values[k1 * nlat + i1];
    const vT = v00 * (1 - fi) + v01 * fi;
    const vB = v10 * (1 - fi) + v11 * fi;
    return vT * (1 - fK) + vB * fK;
}

/** Does the (lat, p) point of a zonal diagnostic touch a cell that is
 *  blank as ground (zm.ground, air_mask.js), or with `mask` = zm.edge as
 *  the top of the grid (EP flux)? The heatmap hatches it. */
function onGround(zm, lat, p, mask = zm.ground) {
    if (!mask) return false;
    const { nlat } = GRID;
    const { levels } = zm;
    const rLat = 90 - lat;
    if (rLat < 0 || rLat > nlat - 1) return false;
    const i0 = Math.max(0, Math.min(nlat - 1, Math.floor(rLat)));
    const i1 = Math.max(0, Math.min(nlat - 1, i0 + 1));
    let k0 = 0;
    while (k0 < levels.length - 1 && levels[k0 + 1] < p) k0++;
    const k1 = Math.min(levels.length - 1, k0 + 1);
    return !!(mask[k0 * nlat + i0] || mask[k0 * nlat + i1]
            || mask[k1 * nlat + i0] || mask[k1 * nlat + i1]);
}

/** Every curve of a multi-series zonal line plot at `lat` — for the hover
 *  tooltip. Null for single-series plots and heatmaps. */
export function sampleSeries(zm, lat) {
    if (!zm?.series?.length || zm.kind !== 'zonal' || zm.type !== 'sl') return null;
    return zm.series.map((s) => ({
        label: s.label, color: s.color, value: sampleZonalSL({ values: s.values }, lat),
    }));
}

function sampleZonalSL(zm, lat) {
    const { nlat } = GRID;
    const rLat = 90 - lat;
    if (rLat < 0 || rLat > nlat - 1) return NaN;
    const i0 = Math.max(0, Math.min(nlat - 1, Math.floor(rLat)));
    const i1 = Math.max(0, Math.min(nlat - 1, i0 + 1));
    const fi = rLat - i0;
    const v0 = zm.values[i0], v1 = zm.values[i1];
    return v0 * (1 - fi) + v1 * fi;
}

function sampleArcPL(zm, sIdx, p) {
    const { values, levels, nSamples } = zm;
    const nlev = levels.length;
    const j0 = Math.max(0, Math.min(nSamples - 1, Math.floor(sIdx)));
    const j1 = Math.min(nSamples - 1, j0 + 1);
    const fJ = sIdx - j0;
    let k0 = 0;
    while (k0 < nlev - 1 && levels[k0 + 1] < p) k0++;
    const k1 = Math.min(nlev - 1, k0 + 1);
    const fK = (k0 === k1) ? 0 : Math.log(p / levels[k0]) / Math.log(levels[k1] / levels[k0]);
    const v00 = values[k0 * nSamples + j0], v01 = values[k0 * nSamples + j1];
    const v10 = values[k1 * nSamples + j0], v11 = values[k1 * nSamples + j1];
    const vT = v00 * (1 - fJ) + v01 * fJ;
    const vB = v10 * (1 - fJ) + v11 * fJ;
    return vT * (1 - fK) + vB * fK;
}

/** Surface pressure (hPa) at fractional sample index sIdx of an arc
 *  section, linear between samples; NaN when the section has none. */
function surfaceAt(zm, sIdx) {
    const s = zm.surface;
    if (!s) return NaN;
    const j0 = Math.max(0, Math.min(zm.nSamples - 1, Math.floor(sIdx)));
    const j1 = Math.min(zm.nSamples - 1, j0 + 1);
    const fJ = sIdx - j0;
    return s[j0] * (1 - fJ) + s[j1] * fJ;
}

function sampleArcSL(zm, sIdx) {
    const { values, nSamples } = zm;
    const j0 = Math.max(0, Math.min(nSamples - 1, Math.floor(sIdx)));
    const j1 = Math.min(nSamples - 1, j0 + 1);
    const fJ = sIdx - j0;
    return values[j0] * (1 - fJ) + values[j1] * fJ;
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
export function computeArcCrossSection(fieldName, month, arc, { seasonal = false, year = null, customRange = null, isentropes = null, markTheta = null } = {}) {
    const meta = FIELDS[fieldName];
    const nSamples = arc.length;
    if (nSamples < 2) return null;
    // Sum the actual sampled-segment lengths so curved (mid-pinned) arcs
    // report their true along-path distance on the cross-section x-axis,
    // not the endpoint-to-endpoint shortcut.
    const distanceKm = arcPathLengthKm(arc);

    if (meta.type === 'sl') {
        const f = getField(fieldName, { month, seasonal, year, customRange });
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
                 nSamples, arc, distanceKm, name: meta.name, units: meta.units,
                 slice: f.isReal ? sliceOf(f) : null };
    }

    const nlev = LEVELS.length;
    // The surface pressure along the arc (same slice) is the terrain the
    // renderer hatches. Samples under it keep ERA5's extrapolated values for
    // the interpolation down to the surface but set no colour range. Blank
    // until p_s is in.
    const sp = getField('sp', { month, seasonal, year, customRange });
    const surface = sp.isReal ? Float32Array.from(arc, (pt) => bilinearSample(sp.values, pt.lat, pt.lon)) : null;
    const values = new Float32Array(nlev * nSamples).fill(NaN);
    let vmin = Infinity, vmax = -Infinity;
    let slice = null;
    for (let k = 0; k < nlev; k++) {
        const f = getField(fieldName, { month, level: LEVELS[k], seasonal, year, customRange });
        if (f.isReal) slice ??= sliceOf(f);
        if (!surface) continue;
        for (let j = 0; j < nSamples; j++) {
            const v = bilinearSample(f.values, arc[j].lat, arc[j].lon);
            values[k * nSamples + j] = v;
            if (Number.isFinite(v) && !(LEVELS[k] > surface[j])) {
                if (v < vmin) vmin = v;
                if (v > vmax) vmax = v;
            }
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    const out = capRange({ kind: 'arc', type: 'pl', values, vmin, vmax,
                           nSamples, arc, distanceKm, levels: LEVELS.slice(), surface,
                           name: meta.name, units: meta.units, slice }, meta);
    if (isentropes) {
        out.isentropes = isentropeOverlay(isentropes, markTheta, (k) => {
            const t = getField('t', { month, level: LEVELS[k], seasonal, year, customRange });
            return t.isReal && surface ? Float32Array.from(arc, (pt) => bilinearSample(t.values, pt.lat, pt.lon)) : null;
        }, surface);
    }
    return out;
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
        // EP-flux mode overlays vector arrows on top of the ∇·F shading.
        if (zm.arrows) drawEPArrows(ctx, padL, padT, plotW, plotH, zm);
    }
    if (zm.isentropes) drawIsentropes(ctx, padL, padT, plotW, plotH, zm);
}

/** Isentropes over a pressure section (θ coordinates): a thin line per θ
 *  level, the globe's surface (zm.isentropes.mark) bold, each labelled at
 *  its right-hand end. */
function drawIsentropes(ctx, x0, y0, w, h, zm) {
    const { lines, mark } = zm.isentropes;
    const dpr = zm._dpr || 1;
    const n = lines[0]?.p.length || 0;
    if (n < 2) return;
    const pMin = zm.levels[0], pMax = zm.levels[zm.levels.length - 1];
    const logSpan = Math.log(pMax / pMin);
    // Zonal columns are latitudes 90 − j (north on the right); arc columns
    // run start → end.
    const xAt = zm.kind === 'arc'
        ? (j) => x0 + (j / (n - 1)) * w
        : (j) => x0 + ((180 - j) / 180) * w;
    const yAt = (p) => y0 + h * (Math.log(p / pMin) / logSpan);
    const trace = (p) => {
        ctx.beginPath();
        let on = false;
        for (let j = 0; j < n; j++) {
            if (!Number.isFinite(p[j])) { on = false; continue; }
            if (on) ctx.lineTo(xAt(j), yAt(p[j]));
            else { ctx.moveTo(xAt(j), yAt(p[j])); on = true; }
        }
        ctx.stroke();
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.clip();
    ctx.lineJoin = 'round';
    for (const { theta, p } of lines) {
        if (theta === mark) continue;
        ctx.strokeStyle = 'rgba(10, 18, 14, 0.55)';
        ctx.lineWidth = Math.max(1, dpr);
        trace(p);
    }
    const sel = lines.find((l) => l.theta === mark);
    if (sel) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 4.5 * dpr;
        trace(sel.p);
        ctx.strokeStyle = 'rgba(10, 18, 14, 0.95)';
        ctx.lineWidth = 2 * dpr;
        trace(sel.p);
    }
    // Labels at the right-most point of each line, haloed for legibility.
    // The bold surface is labelled first; a thin label that would overlap
    // one already placed is dropped (isentropes bunch where the
    // stratification is strong, e.g. over the winter pole).
    ctx.textAlign = 'right';
    ctx.lineJoin = 'round';
    const placed = [];
    const ordered = [...lines].sort((a, b) => (b.theta === mark) - (a.theta === mark));
    for (const { theta, p } of ordered) {
        let j = -1;
        if (zm.kind === 'arc') { for (let k = n - 1; k >= 0; k--) if (Number.isFinite(p[k])) { j = k; break; } }
        else { for (let k = 0; k < n; k++) if (Number.isFinite(p[k])) { j = k; break; } }
        if (j < 0) continue;
        const bold = theta === mark;
        const yLine = yAt(p[j]);
        if (!bold && placed.some((yp) => Math.abs(yp - yLine) < 10 * dpr)) continue;
        placed.push(yLine);
        ctx.font = `${bold ? 600 : 400} ${(bold ? 10 : 9) * dpr}px 'JetBrains Mono', monospace`;
        const x = Math.min(xAt(j), x0 + w) - 3 * dpr;
        let y = yLine - 2 * dpr;
        ctx.textBaseline = 'bottom';
        if (y - 10 * dpr < y0) { ctx.textBaseline = 'top'; y += 4 * dpr; }
        const text = bold ? `${theta} K` : `${theta}`;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 3 * dpr;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = 'rgba(10, 18, 14, 0.95)';
        ctx.fillText(text, x, y);
    }
    ctx.restore();
}

function drawArcHeatmap(ctx, x0, y0, w, h, zm, cmap) {
    const { values, vmin, vmax, levels, nSamples } = zm;
    const nlev = levels.length;
    const pMax = levels[nlev - 1];
    const pMin = levels[0];
    const logSpan = Math.log(pMax / pMin);
    const span = (vmax - vmin) || 1;
    const showContours = !!zm.showContours;
    const interval = zm.contourInterval || 0;
    const dpr = zm._dpr || 1;
    const hatchPeriod = Math.max(4, Math.round(6 * dpr));
    const hatchWidth  = Math.max(1, Math.round(1.25 * dpr));

    const iw = Math.floor(w), ih = Math.floor(h);
    const img = ctx.createImageData(iw, ih);
    const data = img.data;
    // Per-pixel values for the contour pass (NaN where nothing is drawn).
    const grid = showContours && interval > 0 ? new Float32Array(iw * ih).fill(NaN) : null;
    let hasNeg = false, hasPos = false;
    // Surface pressure under each pixel column: below it is ground, hatched
    // like the zonal sections' below-ground cells.
    const psCol = zm.surface
        ? Float32Array.from({ length: iw }, (_, px) => surfaceAt(zm, (px / (iw - 1)) * (nSamples - 1)))
        : null;

    for (let py = 0; py < ih; py++) {
        const p = pMin * Math.exp((py / (ih - 1)) * logSpan);
        let k0 = 0;
        while (k0 < nlev - 1 && levels[k0 + 1] < p) k0++;
        const k1 = Math.min(nlev - 1, k0 + 1);
        const fLev = (k0 === k1) ? 0
            : Math.log(p / levels[k0]) / Math.log(levels[k1] / levels[k0]);
        for (let px = 0; px < iw; px++) {
            const k = (py * iw + px) * 4;
            if (psCol && p > psCol[px]) {
                if ((px + py) % hatchPeriod < hatchWidth) {
                    data[k] = 66; data[k+1] = 84; data[k+2] = 74; data[k+3] = 255;
                } else {
                    data[k] = 18; data[k+1] = 26; data[k+2] = 22; data[k+3] = 255;
                }
                continue;
            }
            const sIdx = (px / (iw - 1)) * (nSamples - 1);
            const j0 = Math.floor(sIdx);
            const j1 = Math.min(nSamples - 1, j0 + 1);
            const fS = sIdx - j0;
            const v00 = values[k0 * nSamples + j0], v01 = values[k0 * nSamples + j1];
            const v10 = values[k1 * nSamples + j0], v11 = values[k1 * nSamples + j1];
            const vT = v00 * (1 - fS) + v01 * fS;
            const vB = v10 * (1 - fS) + v11 * fS;
            const v  = vT * (1 - fLev) + vB * fLev;
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
            if (grid) {
                grid[py * iw + px] = v;
                if (v < 0) hasNeg = true; else if (v > 0) hasPos = true;
            }
        }
    }
    if (grid) paintContours(data, grid, iw, ih, interval, hasNeg && hasPos, dpr);
    ctx.putImageData(img, x0, y0);
    drawPanelGrid(ctx, x0, y0, w, h, zm);
    // Terrain outline along the surface pressure.
    if (psCol) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, w, h);
        ctx.clip();
        ctx.strokeStyle = 'rgba(174, 195, 182, 0.9)';
        ctx.lineWidth = 1.25 * dpr;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let px = 0; px < iw; px++) {
            const y = y0 + (Math.log(psCol[px] / pMin) / logSpan) * (ih - 1);
            if (px === 0) ctx.moveTo(x0 + px, y);
            else          ctx.lineTo(x0 + px, y);
        }
        ctx.stroke();
        ctx.restore();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = dpr;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
}

/** Contour lines over a rendered heatmap, anti-aliased the way the globe's
 *  contour shader draws them: a pixel's distance to the nearest multiple of
 *  `interval` is |v − level| / |∇v| in pixels, and a line `lw` wide fades out
 *  over one pixel. A level counts only where it is crossed within a few
 *  pixels, so near-flat regions don't smear; the zero line of a field with
 *  both signs is drawn bold. `grid` holds v per pixel (NaN = no data). */
function paintContours(data, grid, iw, ih, interval, zeroBold, dpr) {
    const lw = 1.1 * dpr, lwZ = 2.2 * dpr;
    const R = Math.max(1, Math.ceil(lwZ / 2 + 1));
    const A = 0.75, AZ = 0.9;
    for (let py = 0; py < ih; py++) {
        for (let px = 0; px < iw; px++) {
            const idx = py * iw + px;
            const v = grid[idx];
            if (!Number.isFinite(v)) continue;
            const g = Math.hypot(slope(grid, idx, px, iw, 1), slope(grid, idx, py, ih, iw));
            if (!(g > 0)) continue;
            const kSelf = Math.floor(v / interval);
            let crossed = false, flips = false, nbMax = 0;
            for (const j of [px >= R ? idx - R : -1, px + R < iw ? idx + R : -1,
                             py >= R ? idx - R * iw : -1, py + R < ih ? idx + R * iw : -1]) {
                if (j < 0 || !Number.isFinite(grid[j])) continue;
                if (Math.floor(grid[j] / interval) !== kSelf) crossed = true;
                if ((grid[j] < 0) !== (v < 0)) flips = true;
                nbMax = Math.max(nbMax, Math.abs(grid[j]));
            }
            // A zero crossing where the field is negligible (ψ in the
            // stratosphere) is noise, not a contour.
            if (Math.round(v / interval) === 0 && nbMax < 0.15 * interval) continue;
            let a = 0;
            if (crossed) {
                const f = v / interval - kSelf;
                a = A * (1 - smoothstep(lw / 2 - 0.5, lw / 2 + 0.5, Math.min(f, 1 - f) * interval / g));
            }
            if (zeroBold && flips) {
                a = Math.max(a, AZ * (1 - smoothstep(lwZ / 2 - 0.5, lwZ / 2 + 0.5, Math.abs(v) / g)));
            }
            if (a > 0.01) {
                const k = idx * 4;
                data[k]     += (12 - data[k])     * a;
                data[k + 1] += (20 - data[k + 1]) * a;
                data[k + 2] += (16 - data[k + 2]) * a;
            }
        }
    }
}

/** Centred difference of grid along one axis, one-sided beside an edge or a gap. */
function slope(grid, idx, pos, n, stride) {
    const a = pos > 0 ? grid[idx - stride] : NaN;
    const b = pos < n - 1 ? grid[idx + stride] : NaN;
    if (Number.isFinite(a) && Number.isFinite(b)) return (b - a) / 2;
    if (Number.isFinite(b)) return b - grid[idx];
    if (Number.isFinite(a)) return grid[idx] - a;
    return 0;
}

function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/** Faint gridlines inside the plot area: horizontal at pressure ticks,
 *  vertical at quarter marks along the arc / latitude. */
function drawPanelGrid(ctx, x0, y0, w, h, zm) {
    const dpr = zm._dpr || 1;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    ctx.beginPath();
    if (zm.type === 'pl') {
        const pMax = zm.levels[zm.levels.length - 1];
        const pMin = zm.levels[0];
        const logSpan = Math.log(pMax / pMin);
        for (const p of pTicksFor(pMin)) {
            if (p < pMin || p > pMax) continue;
            const y = y0 + h * (Math.log(p / pMin) / logSpan);
            ctx.moveTo(x0, y + 0.5);
            ctx.lineTo(x0 + w, y + 0.5);
        }
    }
    // Vertical quarter marks.
    for (const t of [0.25, 0.5, 0.75]) {
        const x = Math.round(x0 + t * w) + 0.5;
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y0 + h);
    }
    ctx.stroke();
    ctx.restore();
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
    // (Distance intentionally omitted here — it's already in the panel title.)

    // Pressure ticks on the y-axis (pl fields only).
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#AEC3B6';
    if (zm.type === 'pl') {
        const pMax = zm.levels[zm.levels.length - 1];
        const pMin = zm.levels[0];
        const logSpan = Math.log(pMax / pMin);
        for (const p of pTicksFor(pMin)) {
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
        // Arc 1D line — keep simple corner labels for now (arc plots are
        // bilinear samples, no panel zonal-mean). Same nice-ticks treatment
        // could go here if needed later.
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
    const showContours = !!zm.showContours;
    const interval = zm.contourInterval || 0;
    // Diagnostics mark the cells that are underground (air_mask.js) in
    // zm.ground; blank pixels touching one get a diagonal hatch, the rest of
    // the missing data (the poles, …) the plain dark fill. zm.edge marks a
    // row left out as the top of the grid (EP flux at 10 hPa), hatched
    // along the other diagonal.
    const ground = zm.ground || null;
    const edge = zm.edge || null;
    const dpr = zm._dpr || 1;
    const hatchPeriod = Math.max(4, Math.round(6 * dpr));
    const hatchWidth  = Math.max(1, Math.round(1.25 * dpr));

    const iw = Math.floor(w), ih = Math.floor(h);
    const img = ctx.createImageData(iw, ih);
    const data = img.data;
    // Per-pixel values for the contour pass (NaN where nothing is drawn).
    const grid = showContours && interval > 0 ? new Float32Array(iw * ih).fill(NaN) : null;
    let hasNeg = false, hasPos = false;

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
                const isGround = ground && (ground[k0 * nlat + i0] || ground[k0 * nlat + i1]
                                         || ground[k1 * nlat + i0] || ground[k1 * nlat + i1]);
                const isEdge = !isGround && edge && (edge[k0 * nlat + i0] || edge[k0 * nlat + i1]
                                         || edge[k1 * nlat + i0] || edge[k1 * nlat + i1]);
                if ((isGround && (px + py) % hatchPeriod < hatchWidth)
                    || (isEdge && (px + ih - py) % hatchPeriod < hatchWidth)) {
                    data[k] = 66; data[k+1] = 84; data[k+2] = 74; data[k+3] = 255;
                } else {
                    data[k] = 18; data[k+1] = 26; data[k+2] = 22; data[k+3] = 255;
                }
                continue;
            }
            const t = (v - vmin) / span;
            const [r, g, b] = sample(cmap, t);
            data[k]     = r * 255;
            data[k + 1] = g * 255;
            data[k + 2] = b * 255;
            data[k + 3] = 255;
            if (grid) {
                grid[py * iw + px] = v;
                if (v < 0) hasNeg = true; else if (v > 0) hasPos = true;
            }
        }
    }
    if (grid) paintContours(data, grid, iw, ih, interval, hasNeg && hasPos, dpr);
    ctx.putImageData(img, x0, y0);
    drawPanelGrid(ctx, x0, y0, w, h, zm);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = zm._dpr || 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
}

function drawLine(ctx, x0, y0, w, h, zm) {
    const { values, vmin, vmax } = zm;
    const { nlat } = GRID;
    const span = (vmax - vmin) || 1;
    const dpr = zm._dpr || 1;

    // Faint horizontal gridlines at "nice" tick positions.
    const ticks = niceTicks(vmin, vmax, 7);
    ctx.save();
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    for (const t of ticks) {
        const y = y0 + h - ((t - vmin) / span) * h;
        if (Math.abs(t) < 1e-9) {
            // Emphasised zero reference line — solid, brighter.
            ctx.strokeStyle = 'rgba(232, 194, 106, 0.55)';   // amber
            ctx.setLineDash([]);
        } else {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
            ctx.setLineDash([3 * dpr, 3 * dpr]);
        }
        ctx.beginPath();
        ctx.moveTo(x0, y + 0.5);
        ctx.lineTo(x0 + w, y + 0.5);
        ctx.stroke();
    }
    // Vertical quarter marks (latitude grid).
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    for (const t of [0.25, 0.5, 0.75]) {
        const x = Math.round(x0 + t * w) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y0 + h);
        ctx.stroke();
    }
    ctx.restore();

    // Plot frame.
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = dpr;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);

    // Series rendering. Multi-series mode (zm.series) draws each one with its
    // own color + a small legend; single-series falls back to the emerald default.
    const series = zm.series && zm.series.length > 0
        ? zm.series
        : [{ values, color: '#2DBDA0', label: zm.name }];

    // Curves beyond the y-range (the budgets take it from within 85° of the
    // equator) stop at the frame; hovering still reads them.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.clip();
    for (const s of series) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = (s.width ?? 2) * dpr;
        ctx.setLineDash(s.dash ? s.dash.map((d) => d * dpr) : []);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < nlat; i++) {
            const v = s.values[i];
            if (!Number.isFinite(v)) { started = false; continue; }
            const lat = 90 - i;
            const x = x0 + ((lat + 90) / 180) * w;
            const y = y0 + h - ((v - vmin) / span) * h;
            if (!started) { ctx.moveTo(x, y); started = true; }
            else          ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    ctx.restore();
    ctx.setLineDash([]);

    // Legend (only if multi-series). Top-right of plot by default; plots
    // whose curves fill that corner (northward transports) ask for the
    // top-left with zm.legendPos = 'tl'.
    if (zm.series && zm.series.length > 1) {
        const fs = 11 * dpr;
        ctx.font = `${fs}px 'DM Sans', system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const padPx = 8 * dpr;
        const swatch = 18 * dpr;
        const lineH  = 15 * dpr;
        // Measure widest label.
        let maxLabel = 0;
        for (const s of zm.series) maxLabel = Math.max(maxLabel, ctx.measureText(s.label).width);
        const itemW = swatch + 6 * dpr + maxLabel + padPx;
        const lx = zm.legendPos === 'tl' ? x0 + padPx + 6 * dpr : x0 + w - itemW - padPx;
        const ly = y0 + padPx;
        // Background panel for legibility.
        ctx.fillStyle = 'rgba(6, 22, 18, 0.78)';
        ctx.fillRect(lx - 6 * dpr, ly - 6 * dpr,
                     itemW + 6 * dpr, lineH * zm.series.length + 6 * dpr);
        for (let si = 0; si < zm.series.length; si++) {
            const s = zm.series[si];
            const yy = ly + si * lineH + lineH / 2;
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 2.5 * dpr;
            ctx.setLineDash(s.dash ? s.dash.map((d) => d * dpr) : []);
            ctx.beginPath();
            ctx.moveTo(lx, yy);
            ctx.lineTo(lx + swatch, yy);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#E6EFE9';
            ctx.fillText(s.label, lx + swatch + 6 * dpr, yy);
        }
    }

    // Stash ticks for the axis renderer to label.
    zm._yTicks = ticks;
}

/** Pick ~n "nice" round-number ticks inside [vmin, vmax] including 0 if in range. */
export function niceTicks(vmin, vmax, n = 5) {
    const span = vmax - vmin;
    if (!(span > 0)) return [vmin];
    const rough = span / Math.max(1, n - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if      (norm < 1.5) step = 1 * mag;
    else if (norm < 3)   step = 2 * mag;
    else if (norm < 7)   step = 5 * mag;
    else                 step = 10 * mag;
    const start = Math.ceil(vmin / step) * step;
    const ticks = [];
    for (let t = start; t <= vmax + 1e-9 * step; t += step) {
        // Round to suppress fp drift.
        ticks.push(Math.round(t / step) * step);
    }
    // Force-include 0 if it's in range and not already a tick.
    if (vmin <= 0 && vmax >= 0 && !ticks.some(t => Math.abs(t) < 1e-9 * step)) {
        ticks.push(0);
        ticks.sort((a, b) => a - b);
    }
    return ticks;
}

/**
 * Edmon–Hoskins–McIntyre arrows on the (lat, log-p) panel. zm.arrows holds
 * pre-balanced (dx, dy), so direction is true in (φ, log p) space. Length
 * goes as √|F|: the longest of the panel's interior (maxLen from ep_flux.js)
 * fills ~LONG_FRAC of the panel width, longer arrows (near the ground)
 * saturate there, and a boxed reference arrow gives the scale.
 */
function drawEPArrows(ctx, x0, y0, w, h, zm) {
    const dpr = zm._dpr || 1;
    const { arrows, levels } = zm;
    const pMin = levels[0], pMax = levels[levels.length - 1];
    const logSpan = Math.log(pMax / pMin);
    const LONG_FRAC = 0.08;     // longest arrow ≈ 8% of plot width, about the arrow spacing

    let maxLen = arrows.maxLen || 0;
    if (!(maxLen > 0)) {
        for (let i = 0; i < arrows.dx.length; i++) {
            const m = Math.hypot(arrows.dx[i], arrows.dy[i]);
            if (m > maxLen) maxLen = m;
        }
    }
    if (maxLen === 0) return;
    const targetPx = LONG_FRAC * w;
    // Length ∝ √|F|: the interior's longest arrow keeps the standard length,
    // weak ones stay readable instead of shrinking to dust, and the strong
    // near-surface ones saturate at it instead of spiking.
    const lengthPx = (m) => targetPx * Math.sqrt(Math.min(m / maxLen, 1));

    ctx.save();
    // Dark ink with thin white halo for legibility on both pale (∇·F ≈ 0) and
    // saturated red/blue regions of the divergent colormap.
    const drawArrow = (x, y, x2, y2, lineW, headSize) => {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.lineWidth = lineW;
        ctx.stroke();
        const ang = Math.atan2(y2 - y, x2 - x);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - headSize * Math.cos(ang - Math.PI / 6),
                   y2 - headSize * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(x2 - headSize * Math.cos(ang + Math.PI / 6),
                   y2 - headSize * Math.sin(ang + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
    };

    const dustThresh = 2.5 * dpr;
    const lineW    = Math.max(1.4, dpr * 1.6);
    const haloW    = lineW + 2 * dpr;
    const headSize = Math.max(5, dpr * 5.5);

    for (let i = 0; i < arrows.lats.length; i++) {
        const lat = arrows.lats[i];
        const p   = arrows.pressures[i];
        const m = Math.hypot(arrows.dx[i], arrows.dy[i]);
        const len = lengthPx(m);
        if (!(len >= dustThresh)) continue;
        const dx = arrows.dx[i] / m * len;
        const dy = arrows.dy[i] / m * len;
        const x  = x0 + ((lat + 90) / 180) * w;
        const y  = y0 + h * (Math.log(p / pMin) / logSpan);
        const x2 = x + dx;
        const y2 = y + dy;
        // Halo first (white, slightly wider) for legibility.
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillStyle   = 'rgba(255, 255, 255, 0.85)';
        drawArrow(x, y, x2, y2, haloW, headSize + dpr);
        // Then dark arrow on top.
        ctx.strokeStyle = 'rgba(10, 18, 14, 0.95)';
        ctx.fillStyle   = 'rgba(10, 18, 14, 0.95)';
        drawArrow(x, y, x2, y2, lineW, headSize);
    }

    // Reference arrow, boxed in the bottom-left corner (Antarctic ground):
    // a round F_φ near a quarter of the longest, i.e. about half its length.
    // Its value goes in the caption through zm._arrowKey.
    const fRef = roundDown(maxLen / 4);
    const refLen = lengthPx(fRef);
    if (refLen >= dustThresh) {
        ctx.font = `${10 * dpr}px 'DM Sans', system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const label = 'reference';
        const boxW = refLen + ctx.measureText(label).width + 22 * dpr;
        const boxH = 18 * dpr;
        const bx = x0 + 5 * dpr, by = y0 + h - boxH - 5 * dpr;
        ctx.fillStyle = 'rgba(6, 22, 18, 0.82)';
        ctx.fillRect(bx, by, boxW, boxH);
        const ay = by + boxH / 2;
        ctx.strokeStyle = ctx.fillStyle = 'rgba(230, 239, 233, 0.95)';
        drawArrow(bx + 7 * dpr, ay, bx + 7 * dpr + refLen, ay, lineW, headSize);
        ctx.fillText(label, bx + refLen + 14 * dpr, ay);
        zm._arrowKey = { fphi: fRef, fp: arrows.vGain > 0 ? fRef / arrows.vGain : NaN };
    }
    ctx.restore();
}

/** The largest 1, 2 or 5 × 10ⁿ not above x. */
function roundDown(x) {
    const mag = Math.pow(10, Math.floor(Math.log10(x)));
    const n = x / mag;
    return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * mag;
}

function drawAxes(ctx, x0, y0, w, h, zm) {
    const dpr = zm._dpr || 1;
    ctx.font = `${11 * dpr}px 'JetBrains Mono', monospace`;
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
        // Hemisphere-style labels; the end ticks hug the frame so they don't spill past it.
        ctx.textAlign = lat === -90 ? 'left' : lat === 90 ? 'right' : 'center';
        ctx.fillText(latLabel(lat), x, y0 + h + 5 * dpr);
    }
    ctx.textAlign = 'center';

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    if (zm.type === 'pl') {
        const pMax = zm.levels[zm.levels.length - 1];
        const pMin = zm.levels[0];
        const logSpan = Math.log(pMax / pMin);
        for (const p of pTicksFor(pMin)) {
            if (p < pMin || p > pMax) continue;
            const y = y0 + h * (Math.log(p / pMin) / logSpan);
            ctx.beginPath();
            ctx.moveTo(x0 - 3 * dpr, y);
            ctx.lineTo(x0, y);
            ctx.stroke();
            ctx.fillText(`${p}`, x0 - 5 * dpr, y);
        }
        ctx.save();
        ctx.translate(x0 - 34 * dpr, y0 + h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText('hPa', 0, 0);
        ctx.restore();
    } else {
        // SL line plot — label every nice tick (computed by drawLine) with
        // the zero line emphasised in amber so divergent quantities have an
        // obvious reference baseline.
        const ticks = zm._yTicks || [zm.vmin, zm.vmax];
        const span  = (zm.vmax - zm.vmin) || 1;
        const tStep = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
        const decimals = tStep >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(tStep) - 1e-9));
        for (const t of ticks) {
            const y = y0 + h - ((t - zm.vmin) / span) * h;
            ctx.beginPath();
            ctx.moveTo(x0 - 3 * dpr, y);
            ctx.lineTo(x0, y);
            ctx.stroke();
            ctx.fillStyle = Math.abs(t) < 1e-9 ? '#E8C26A' : '#AEC3B6';
            ctx.fillText(t.toFixed(decimals), x0 - 5 * dpr, y);
        }
        ctx.fillStyle = '#AEC3B6';
        // Y-axis units label (rotated, on the left).
        if (zm.units) {
            ctx.save();
            ctx.translate(x0 - 35 * dpr, y0 + h / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.fillText(zm.units, 0, 0);
            ctx.restore();
        }
    }
}
