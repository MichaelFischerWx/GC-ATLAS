// Field provider for the globe.
//
// getField() first asks the ERA5 tile loader (js/era5.js); if the tile isn't
// cached yet, it returns the synthetic placeholder below and the loader
// triggers a background fetch — when it completes, the loader fires an event
// and the caller re-renders.
//
// The synthetic fields produce pedagogically plausible shapes (mid-latitude
// jets, Hadley return, stationary waves, subtropical highs). They exist so
// the renderer works offline / before real tiles are staged.

import { requestField as requestEra5, availableLevels } from './era5.js';

export const GRID = { nlat: 181, nlon: 360 };
export const LEVELS = [10, 50, 100, 150, 200, 250, 300, 500, 700, 850, 925, 1000];
export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export const FIELDS = {
    t:    { type: 'pl', name: 'Temperature',              units: 'K',       cmap: 'turbo',   defaultLevel: 500, contour: 10 },
    u:    { type: 'pl', name: 'Zonal wind (u)',           units: 'm s⁻¹',   cmap: 'RdBu_r',  defaultLevel: 200, contour: 10 },
    v:    { type: 'pl', name: 'Meridional wind (v)',      units: 'm s⁻¹',   cmap: 'RdBu_r',  defaultLevel: 200, contour: 5 },
    wspd: { type: 'pl', name: 'Wind speed (|V|)',         units: 'm s⁻¹',   cmap: 'turbo',   defaultLevel: 200, derived: true, contour: 10 },
    w:    { type: 'pl', name: 'Vertical velocity (ω)',    units: 'Pa s⁻¹',  cmap: 'RdBu_r',  defaultLevel: 500, contour: 0.05 },
    z:    { type: 'pl', name: 'Geopotential height',      units: 'm',       cmap: 'viridis', defaultLevel: 500, contour: 60 },
    msl:  { type: 'sl', name: 'Mean sea-level pressure',  units: 'hPa',     cmap: 'plasma',  contour: 4 },
    sp:   { type: 'sl', name: 'Surface pressure',         units: 'hPa',     cmap: 'plasma',  contour: 20 },
    t2m:  { type: 'sl', name: '2-m temperature',          units: 'K',       cmap: 'turbo',   contour: 5 },
    d2m:  { type: 'sl', name: '2-m dewpoint',             units: 'K',       cmap: 'turbo',   contour: 5 },
    sst:  { type: 'sl', name: 'Sea surface temperature',  units: 'K',       cmap: 'turbo',   contour: 2 },
    tcwv: { type: 'sl', name: 'Precipitable water (TCWV)', units: 'kg m⁻²', cmap: 'thalo',   contour: 5 },
    tp:   { type: 'sl', name: 'Total precipitation',      units: 'mm day⁻¹', cmap: 'thalo',  contour: 2 },
    blh:  { type: 'sl', name: 'Boundary-layer height',    units: 'm',       cmap: 'plasma',  contour: 200 },
    sshf: { type: 'sl', name: 'Surface sensible heat flux', units: 'W m⁻²', cmap: 'RdBu_r',  contour: 20 },
    slhf: { type: 'sl', name: 'Surface latent heat flux',   units: 'W m⁻²', cmap: 'RdBu_r',  contour: 25 },
    ssr:  { type: 'sl', name: 'Surface net SW radiation',   units: 'W m⁻²', cmap: 'plasma',  contour: 25 },
    str:  { type: 'sl', name: 'Surface net LW radiation',   units: 'W m⁻²', cmap: 'RdBu_r',  contour: 10 },
    tisr: { type: 'sl', name: 'TOA incoming solar',         units: 'W m⁻²', cmap: 'plasma',  contour: 50 },
    ttr:  { type: 'sl', name: 'TOA net LW (OLR)',           units: 'W m⁻²', cmap: 'magma',   contour: 20 },
    pv330: { type: 'sl', name: 'PV on 330 K',               units: 'PVU',   cmap: 'RdBu_r',  contour: 1, derived: true, isenLevel: 330 },
};

// ── lat/lon axes ─────────────────────────────────────────────────────────
const LATS = new Float32Array(GRID.nlat);
const LONS = new Float32Array(GRID.nlon);
for (let i = 0; i < GRID.nlat; i++) LATS[i] = 90 - i;
for (let j = 0; j < GRID.nlon; j++) LONS[j] = -180 + j;

// Pending-tile placeholder: all-NaN field. The colormap renders NaN as a
// neutral "no-data" colour (see colormap.js), so the user sees a muted
// globe for the split second before the ERA5 tile lands rather than a fake
// pattern that could be confused with the real data. Retired the
// per-variable synthetic generators — every tile exists on GCS now.
const PENDING_VALUES = new Float32Array(GRID.nlat * GRID.nlon);
PENDING_VALUES.fill(NaN);

function pendingField() {
    return { values: PENDING_VALUES, vmin: 0, vmax: 1 };
}

/**
 * Return { values, vmin, vmax, shape, lats, lons, name, units, cmap, type, isReal }.
 * Prefers real ERA5 tiles when cached; returns an all-NaN placeholder while
 * the tile fetch is in flight (the ERA5 loader fires an event when it
 * arrives so the caller can re-render with real data).
 */
export function getField(name, { month = 1, level = 500 } = {}) {
    const meta = FIELDS[name];
    if (!meta) throw new Error(`unknown field: ${name}`);

    // Derived fields (e.g. wind speed) — compute from component tiles.
    if (meta.derived) {
        const d = computeDerived(name, month, level);
        if (d) {
            return {
                values: d.values, vmin: d.vmin, vmax: d.vmax,
                shape: d.shape ?? [GRID.nlat, GRID.nlon],
                lats: LATS, lons: LONS,
                ...meta,
                isReal: d.isReal,
            };
        }
    } else {
        const era = requestEra5(name, { month, level });
        if (era) {
            return {
                values: era.values,
                vmin: era.vmin, vmax: era.vmax,
                shape: era.shape ?? [GRID.nlat, GRID.nlon],
                lats: LATS, lons: LONS,
                ...meta,
                // Prefer our human-friendly labels over the raw ERA5 strings
                // ("m" > "m**2 s**-2", "hPa" > "Pa", etc.).
                long_name: meta.name,
                units: meta.units,
                isReal: true,
            };
        }
    }

    return {
        ...pendingField(),
        shape: [GRID.nlat, GRID.nlon],
        lats: LATS, lons: LONS,
        ...meta,
        isReal: false,
    };
}

function magnitudeFromUV(u, v) {
    const n = u.length;
    const values = new Float32Array(n);
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < n; i++) {
        const s = Math.hypot(u[i], v[i]);
        values[i] = s;
        if (s < vmin) vmin = s;
        if (s > vmax) vmax = s;
    }
    return { values, vmin, vmax };
}

function computeDerived(name, month, level) {
    if (name === 'wspd') {
        const uE = requestEra5('u', { month, level });
        const vE = requestEra5('v', { month, level });
        if (uE && vE) {
            return { ...magnitudeFromUV(uE.values, vE.values), shape: uE.shape, isReal: true };
        }
        return null;
    }
    if (name === 'pv330') {
        return computePVOnIsentrope(month, 330);
    }
    return null;
}

// ── PV on an isentropic surface ──────────────────────────────────────────
// Ertel PV in pressure coordinates:
//     PV = -g · (ζ + f) · ∂θ/∂p
// where ζ is relative vorticity (we have the ERA5 `vo` tile at every
// pressure level), f = 2Ω sin φ, and θ = T·(1000/p)^(R/cp) is potential
// temperature. We compute PV at every (lat, lon, p) level, then for each
// column linearly interpolate (in p) to the surface where θ = θ₀.

const OMEGA_EARTH = 7.2921e-5;
const G_EARTH     = 9.80665;
const KAPPA       = 0.2854;      // R / cp for dry air

const _pvCache = new Map();

/** Invalidate any cached PV results — called when a new T or vo tile lands. */
export function invalidatePVCache() { _pvCache.clear(); }

function computePVOnIsentrope(month, theta0) {
    const cacheKey = `${month}:${theta0}`;
    const cached = _pvCache.get(cacheKey);
    if (cached?.ready) return cached;

    const { nlat, nlon } = GRID;
    const N = nlat * nlon;
    const nlev = LEVELS.length;

    // Fetch every T and vo tile at the current month; bail if any are
    // missing so the caller can retry when tiles land.
    const Ts  = [];
    const vos = [];
    for (let k = 0; k < nlev; k++) {
        const tT  = requestEra5('t',  { month, level: LEVELS[k] });
        const tVo = requestEra5('vo', { month, level: LEVELS[k] });
        if (!tT || !tVo) return null;
        Ts.push(tT.values);
        vos.push(tVo.values);
    }

    // θ at each level (index same as LEVELS).
    const thetas = [];
    for (let k = 0; k < nlev; k++) {
        const pFactor = Math.pow(1000 / LEVELS[k], KAPPA);
        const theta = new Float32Array(N);
        for (let i = 0; i < N; i++) theta[i] = Ts[k][i] * pFactor;
        thetas.push(theta);
    }

    // Coriolis parameter (1D by latitude).
    const fCor = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        fCor[i] = 2 * OMEGA_EARTH * Math.sin((90 - i) * Math.PI / 180);
    }

    // PV on every pressure level. Units: 1 PVU = 10⁻⁶ K m² kg⁻¹ s⁻¹ ⇒
    // multiply SI result by 1e6.
    const pvLevs = new Array(nlev);
    for (let k = 0; k < nlev; k++) pvLevs[k] = new Float32Array(N);
    for (let k = 0; k < nlev; k++) {
        for (let idx = 0; idx < N; idx++) {
            const i = (idx / nlon) | 0;
            const absVort = vos[k][idx] + fCor[i];
            // ∂θ/∂p via centred differences (forward at top, backward at bottom).
            let dthdp;
            if (k === 0) {
                const dp = (LEVELS[1] - LEVELS[0]) * 100;
                dthdp = (thetas[1][idx] - thetas[0][idx]) / dp;
            } else if (k === nlev - 1) {
                const dp = (LEVELS[nlev - 1] - LEVELS[nlev - 2]) * 100;
                dthdp = (thetas[nlev - 1][idx] - thetas[nlev - 2][idx]) / dp;
            } else {
                const dp = (LEVELS[k + 1] - LEVELS[k - 1]) * 100;
                dthdp = (thetas[k + 1][idx] - thetas[k - 1][idx]) / dp;
            }
            pvLevs[k][idx] = -G_EARTH * absVort * dthdp * 1e6;
        }
    }

    // Interpolate PV to θ = θ₀ at every column. θ is monotonically
    // decreasing with pressure (ascending index in LEVELS), so scan for
    // the first pair bracketing θ₀.
    const out = new Float32Array(N);
    let vmin = Infinity, vmax = -Infinity;
    for (let idx = 0; idx < N; idx++) {
        let kHi = -1;
        for (let k = 0; k < nlev - 1; k++) {
            const thUp = thetas[k][idx];
            const thLo = thetas[k + 1][idx];
            if (Number.isFinite(thUp) && Number.isFinite(thLo) &&
                thUp >= theta0 && theta0 > thLo) {
                kHi = k; break;
            }
        }
        if (kHi < 0) { out[idx] = NaN; continue; }
        const th1 = thetas[kHi][idx];
        const th2 = thetas[kHi + 1][idx];
        const frac = (th1 - theta0) / (th1 - th2);
        const pv = pvLevs[kHi][idx] + frac * (pvLevs[kHi + 1][idx] - pvLevs[kHi][idx]);
        out[idx] = pv;
        if (Number.isFinite(pv)) {
            if (pv < vmin) vmin = pv;
            if (pv > vmax) vmax = pv;
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }

    // Clamp display range for readability — stratospheric intrusions can
    // blow up the limits to hundreds of PVU; cap around ±10 so the
    // tropospheric ribbon keeps its contrast.
    const DISPLAY_CAP = 10;
    vmin = Math.max(vmin, -DISPLAY_CAP);
    vmax = Math.min(vmax,  DISPLAY_CAP);

    const result = {
        values: out, vmin, vmax,
        shape: [nlat, nlon], isReal: true, ready: true,
    };
    _pvCache.set(cacheKey, result);
    return result;
}

/** True if ERA5 has the listed level (or sl fields w/ no level required). */
export function hasRealLevel(name, level) {
    const meta = FIELDS[name];
    if (!meta) return false;
    if (meta.type === 'sl') return true;
    const levels = availableLevels(name);
    return !!(levels && levels.includes(level));
}
