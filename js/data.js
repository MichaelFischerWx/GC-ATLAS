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

import { requestField as requestEra5, availableLevels, cachedMonth } from './era5.js';

export const GRID = { nlat: 181, nlon: 360 };
export const LEVELS = [10, 50, 100, 150, 200, 250, 300, 500, 700, 850, 925, 1000];
export const THETA_LEVELS = [280, 300, 315, 330, 350, 400, 500, 700];
export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export const FIELDS = {
    t:    { type: 'pl', group: 'Dynamics',           name: 'Temperature',              units: 'K',       cmap: 'turbo',   defaultLevel: 500, contour: 10 },
    u:    { type: 'pl', group: 'Dynamics',           name: 'Zonal wind (u)',           units: 'm s⁻¹',   cmap: 'RdBu_r',  defaultLevel: 200, contour: 10 },
    v:    { type: 'pl', group: 'Dynamics',           name: 'Meridional wind (v)',      units: 'm s⁻¹',   cmap: 'RdBu_r',  defaultLevel: 200, contour: 5 },
    wspd: { type: 'pl', group: 'Dynamics',           name: 'Wind speed (|V|)',         units: 'm s⁻¹',   cmap: 'turbo',   defaultLevel: 200, derived: true, contour: 10 },
    vo:   { type: 'pl', group: 'Dynamics',           name: 'Relative vorticity (ζ)',   units: '10⁻⁵ s⁻¹', cmap: 'RdBu_r', defaultLevel: 500, contour: 2,  clamp: { lo: 0.03, hi: 0.97 } },
    d:    { type: 'pl', group: 'Dynamics',           name: 'Horizontal divergence',    units: '10⁻⁵ s⁻¹', cmap: 'RdBu_r', defaultLevel: 200, contour: 1,  clamp: { lo: 0.03, hi: 0.97 } },
    w:    { type: 'pl', group: 'Dynamics',           name: 'Vertical velocity (ω)',    units: 'Pa s⁻¹',  cmap: 'RdBu_r',  defaultLevel: 500, contour: 0.05, clamp: { lo: 0.05, hi: 0.95 } },
    z:    { type: 'pl', group: 'Dynamics',           name: 'Geopotential height',      units: 'm',       cmap: 'viridis', defaultLevel: 500, contour: 60 },
    psi:  { type: 'pl', group: 'Dynamics',           name: 'Streamfunction (ψ)',       units: '10⁶ m² s⁻¹', cmap: 'RdBu_r', defaultLevel: 200, contour: 20 },
    chi:  { type: 'pl', group: 'Dynamics',           name: 'Velocity potential (χ)',   units: '10⁶ m² s⁻¹', cmap: 'RdBu_r', defaultLevel: 200, contour: 2 },
    q:    { type: 'pl', group: 'Moisture',           name: 'Specific humidity',        units: 'g kg⁻¹',  cmap: 'thalo',   defaultLevel: 850, contour: 2 },
    r:    { type: 'pl', group: 'Moisture',           name: 'Relative humidity',        units: '%',       cmap: 'thalo',   defaultLevel: 700, contour: 10 },
    pv:   { type: 'pl', group: 'Derived & PV',       name: 'Ertel PV',                 units: 'PVU',     cmap: 'RdBu_r',  defaultLevel: 330, contour: 1, derived: true, thetaOnly: true },
    mse:  { type: 'pl', group: 'Derived & PV',       name: 'Moist static energy (h/c_p)', units: 'K',    cmap: 'magma',   defaultLevel: 850, contour: 5, derived: true },
    t2m:  { type: 'sl', group: 'Surface',            name: '2-m temperature',          units: 'K',       cmap: 'turbo',   contour: 5 },
    d2m:  { type: 'sl', group: 'Surface',            name: '2-m dewpoint',             units: 'K',       cmap: 'turbo',   contour: 5 },
    sst:  { type: 'sl', group: 'Surface',            name: 'Sea surface temperature',  units: 'K',       cmap: 'turbo',   contour: 2 },
    msl:  { type: 'sl', group: 'Surface',            name: 'Mean sea-level pressure',  units: 'hPa',     cmap: 'plasma',  contour: 4 },
    sp:   { type: 'sl', group: 'Surface',            name: 'Surface pressure',         units: 'hPa',     cmap: 'plasma',  contour: 20 },
    blh:  { type: 'sl', group: 'Surface',            name: 'Boundary-layer height',    units: 'm',       cmap: 'plasma',  contour: 200 },
    tcwv: { type: 'sl', group: 'Moisture',           name: 'Precipitable water (TCWV)', units: 'kg m⁻²', cmap: 'thalo',   contour: 5 },
    tp:   { type: 'sl', group: 'Moisture',           name: 'Total precipitation',      units: 'mm day⁻¹', cmap: 'thalo',  contour: 2,  clamp: { lo: 0.0, hi: 0.99 } },
    ews:  { type: 'sl', group: 'Surface fluxes',     name: 'Eastward surface stress',  units: 'N m⁻²',  cmap: 'RdBu_r',  contour: 0.05 },
    sshf: { type: 'sl', group: 'Surface fluxes',     name: 'Surface sensible heat flux', units: 'W m⁻²', cmap: 'RdBu_r',  contour: 20 },
    slhf: { type: 'sl', group: 'Surface fluxes',     name: 'Surface latent heat flux',   units: 'W m⁻²', cmap: 'RdBu_r',  contour: 25 },
    ssr:  { type: 'sl', group: 'Surface fluxes',     name: 'Surface net SW radiation',   units: 'W m⁻²', cmap: 'plasma',  contour: 25 },
    str:  { type: 'sl', group: 'Surface fluxes',     name: 'Surface net LW radiation',   units: 'W m⁻²', cmap: 'RdBu_r',  contour: 10 },
    tisr: { type: 'sl', group: 'TOA',                name: 'TOA incoming solar',         units: 'W m⁻²', cmap: 'plasma',  contour: 50 },
    ttr:  { type: 'sl', group: 'TOA',                name: 'TOA net LW (OLR)',           units: 'W m⁻²', cmap: 'magma',   contour: 20 },
};

/** Fields that only make sense on isentropic surfaces. When user picks one of
 *  these, the vertical-coord toggle forces θ coordinates. */
export function isThetaOnly(name) { return !!FIELDS[name]?.thetaOnly; }

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
 *
 * `coord` selects the vertical coordinate: 'pressure' (use `level`, hPa) or
 * 'theta' (use `theta`, K). Isentropic rendering interpolates pressure-level
 * tiles to the requested θ surface per column; tropics near low θ and the
 * upper stratosphere near high θ return NaN where θ₀ is out of range.
 */
export function getField(name, { month = 1, level = 500, coord = 'pressure', theta = 330, kind = 'mean', period = 'default' } = {}) {
    const meta = FIELDS[name];
    if (!meta) throw new Error(`unknown field: ${name}`);

    const isenMode = (coord === 'theta') && meta.type === 'pl';

    // Derived / isentropic fields don't have pre-computed std tiles —
    // computing std-of-derived from std-of-components requires assumptions
    // about correlation that aren't generally valid. Fall back to mean for
    // those paths in std mode (and tag the return so UI can surface this).
    const stdUnsupported = kind === 'std' && (meta.derived || isenMode);
    const effKind = stdUnsupported ? 'mean' : kind;
    // Reference-period (non-default) only supported for raw fields. Derived /
    // isentropic paths collapse back to default period so existing diagnostic
    // logic keeps working.
    const periodUnsupported = period !== 'default' && (meta.derived || isenMode);
    const effPeriod = periodUnsupported ? 'default' : period;

    // Derived fields (e.g. wind speed, PV) — compute from component tiles.
    if (meta.derived) {
        const d = computeDerived(name, month, level, coord, theta);
        if (d) {
            return {
                values: d.values, vmin: d.vmin, vmax: d.vmax,
                shape: d.shape ?? [GRID.nlat, GRID.nlon],
                lats: LATS, lons: LONS,
                ...meta,
                isReal: d.isReal,
                kind: 'mean',
                stdUnavailable: stdUnsupported,
            };
        }
    } else if (isenMode) {
        const d = fieldOnIsentrope(name, month, theta);
        if (d) {
            return {
                values: d.values, vmin: d.vmin, vmax: d.vmax,
                shape: [GRID.nlat, GRID.nlon],
                lats: LATS, lons: LONS,
                ...meta,
                long_name: meta.name,
                units: meta.units,
                isReal: true,
                kind: 'mean',
                stdUnavailable: stdUnsupported,
            };
        }
    } else {
        const era = requestEra5(name, { month, level, kind: effKind, period: effPeriod });
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
                kind: effKind,
                period: effPeriod,
            };
        }
    }

    return {
        ...pendingField(),
        shape: [GRID.nlat, GRID.nlon],
        lats: LATS, lons: LONS,
        ...meta,
        isReal: false,
        kind: effKind,
        period: effPeriod,
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

// Moist static energy: h = c_p·T + g·z + L_v·q, displayed as h/c_p (K).
// Pressure-coord uses cached t/z/q tiles; θ-coord interpolates each ingredient
// to the requested isentropic surface.  q is stored in g/kg (×1000 from raw),
// so divide back to kg/kg before applying L_v.
const CP_DRY = 1004;          // J kg⁻¹ K⁻¹
const G_MSE  = 9.80665;
const L_V    = 2.501e6;       // J kg⁻¹  (latent heat of vaporisation, ~273 K)
const _mseCache = new Map();  // `${coord}:${level|theta}:${month}` → {values, vmin, vmax}

function computeMSEFromTiles(tT, tZ, tQ) {
    const n = tT.length;
    const out = new Float32Array(n);
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < n; i++) {
        const T = tT[i], Z = tZ[i], Q = tQ[i];
        if (!Number.isFinite(T) || !Number.isFinite(Z) || !Number.isFinite(Q)) {
            out[i] = NaN; continue;
        }
        // Z is geopotential HEIGHT (m) after era5.js's m²/s² → m conversion;
        // multiply by g to recover g·z. Q is g/kg → divide by 1000 for kg/kg.
        const h = CP_DRY * T + G_MSE * Z + L_V * (Q / 1000);
        const hOverCp = h / CP_DRY;
        out[i] = hOverCp;
        if (hOverCp < vmin) vmin = hOverCp;
        if (hOverCp > vmax) vmax = hOverCp;
    }
    if (!Number.isFinite(vmin)) { vmin = 250; vmax = 360; }
    return { values: out, vmin, vmax };
}

function computeDerived(name, month, level, coord, theta) {
    if (name === 'wspd') {
        // Opportunistically fill _wspdCache for any month whose u/v ingredients
        // are already cached — keeps the aggregate colorbar stable as the user
        // scrubs months instead of re-shifting per visit. Mirrors the MSE fix.
        for (let m = 1; m <= 12; m++) {
            const k = `${coord}:${coord === 'theta' ? theta : level}:${m}`;
            if (_wspdCache.has(k)) continue;
            let uVals, vVals;
            if (coord === 'theta') {
                const uI = fieldOnIsentrope('u', m, theta);
                const vI = fieldOnIsentrope('v', m, theta);
                if (!uI || !vI) continue;
                uVals = uI.values; vVals = vI.values;
            } else {
                const u = cachedMonth('u', m, level);
                const v = cachedMonth('v', m, level);
                if (!u || !v) continue;
                uVals = u; vVals = v;
            }
            _wspdCache.set(k, magnitudeFromUV(uVals, vVals));
        }

        const key = `${coord}:${coord === 'theta' ? theta : level}:${month}`;
        let entry = _wspdCache.get(key);
        if (!entry) {
            // Current month's u/v aren't cached yet → trigger fetch via requestEra5.
            let uVals, vVals;
            if (coord === 'theta') {
                const uI = fieldOnIsentrope('u', month, theta);
                const vI = fieldOnIsentrope('v', month, theta);
                if (!uI || !vI) return null;
                uVals = uI.values; vVals = vI.values;
            } else {
                const uE = requestEra5('u', { month, level });
                const vE = requestEra5('v', { month, level });
                if (!uE || !vE) return null;
                uVals = uE.values; vVals = vE.values;
            }
            entry = magnitudeFromUV(uVals, vVals);
            _wspdCache.set(key, entry);
        }
        // Aggregate colorbar range across every cached month at (coord, level/theta).
        const prefix = `${coord}:${coord === 'theta' ? theta : level}:`;
        const agg = aggregateRangeByPrefix(_wspdCache, prefix);
        return {
            values: entry.values,
            vmin: agg ? agg.vmin : entry.vmin,
            vmax: agg ? agg.vmax : entry.vmax,
            isReal: true,
        };
    }
    if (name === 'pv') {
        const theta0 = (coord === 'theta') ? theta : 330;
        return computePVOnIsentrope(month, theta0);
    }
    if (name === 'mse') {
        // Opportunistically fill _mseCache for any month whose ingredients
        // (t, z, q) are already cached — keeps the aggregate colorbar stable
        // as the user scrubs months instead of re-shifting on each new visit.
        if (coord !== 'theta') {
            for (let m = 1; m <= 12; m++) {
                const k = `pressure:${level}:${m}`;
                if (_mseCache.has(k)) continue;
                const t = cachedMonth('t', m, level);
                const z = cachedMonth('z', m, level);
                const q = cachedMonth('q', m, level);
                if (t && z && q) {
                    _mseCache.set(k, computeMSEFromTiles(t, z, q));
                }
            }
        }
        const key = `${coord}:${coord === 'theta' ? theta : level}:${month}`;
        let entry = _mseCache.get(key);
        if (!entry) {
            let tT, tZ, tQ;
            if (coord === 'theta') {
                const Ti = fieldOnIsentrope('t', month, theta);
                const Zi = fieldOnIsentrope('z', month, theta);
                const Qi = fieldOnIsentrope('q', month, theta);
                if (!Ti || !Zi || !Qi) return null;
                tT = Ti.values; tZ = Zi.values; tQ = Qi.values;
            } else {
                const Te = requestEra5('t', { month, level });
                const Ze = requestEra5('z', { month, level });
                const Qe = requestEra5('q', { month, level });
                if (!Te || !Ze || !Qe) return null;
                tT = Te.values; tZ = Ze.values; tQ = Qe.values;
            }
            entry = computeMSEFromTiles(tT, tZ, tQ);
            _mseCache.set(key, entry);
        }
        const prefix = `${coord}:${coord === 'theta' ? theta : level}:`;
        const agg = aggregateRangeByPrefix(_mseCache, prefix);
        return {
            values: entry.values,
            vmin: agg ? agg.vmin : entry.vmin,
            vmax: agg ? agg.vmax : entry.vmax,
            isReal: true,
        };
    }
    return null;
}

// ── PV on an isentropic surface ──────────────────────────────────────────
// Ertel PV in pressure coordinates:
//     PV = -g · (ζ + f) · ∂θ/∂p
// ERA5 monthly climatology tiles include u, v, t on pressure levels but NOT
// relative vorticity, so we compute ζ on the fly in spherical coordinates:
//     ζ = (1/(a·cosφ)) · [∂v/∂λ - ∂(u·cosφ)/∂φ]
// f = 2Ω sin φ, and θ = T·(1000/p)^(R/cp) is potential temperature. We
// compute PV at every (lat, lon, p) level, then for each column linearly
// interpolate (in p) to the surface where θ = θ₀.

const OMEGA_EARTH = 7.2921e-5;
const G_EARTH     = 9.80665;
const KAPPA       = 0.2854;      // R / cp for dry air
const A_EARTH_PV  = 6.371e6;     // m

const _pvCache = new Map();
const _thetaCubeCache = new Map();    // month → Array<Float32Array> (θ per level)
const _isenFieldCache = new Map();    // `${name}:${month}:${theta0}` → {values, vmin, vmax}
const _wspdCache = new Map();         // `${month}:${level|theta}:${coord}` → {values, vmin, vmax}

/** Aggregate vmin/vmax across every cached entry whose key matches `prefix`.
 *  Used so derived/isentropic fields keep a stable colorbar as the user
 *  scrubs months — mirrors what era5.js does for raw tiles. */
function aggregateRangeByPrefix(cacheMap, prefix) {
    let vmin = Infinity, vmax = -Infinity, any = false;
    for (const [key, val] of cacheMap) {
        if (!key.startsWith(prefix)) continue;
        if (!Number.isFinite(val.vmin) || !Number.isFinite(val.vmax)) continue;
        if (val.vmin < vmin) vmin = val.vmin;
        if (val.vmax > vmax) vmax = val.vmax;
        any = true;
    }
    return any ? { vmin, vmax } : null;
}

/** Build (or reuse) the per-level θ cube for `month`. Requires T tiles at
 *  every LEVEL; returns null if any are missing. */
function buildThetaCube(month) {
    const hit = _thetaCubeCache.get(month);
    if (hit) return hit;
    const { nlat, nlon } = GRID;
    const N = nlat * nlon;
    const thetas = [];
    for (let k = 0; k < LEVELS.length; k++) {
        const tT = requestEra5('t', { month, level: LEVELS[k] });
        if (!tT) return null;
        const pFactor = Math.pow(1000 / LEVELS[k], KAPPA);
        const theta = new Float32Array(N);
        for (let i = 0; i < N; i++) theta[i] = tT.values[i] * pFactor;
        thetas.push(theta);
    }
    _thetaCubeCache.set(month, thetas);
    return thetas;
}

/** Interpolate per-level values to the θ₀ surface, column by column. θ is
 *  monotonically decreasing with increasing LEVELS index (higher p → lower θ
 *  in a statically-stable atmosphere), so scan adjacent pairs for the first
 *  bracketing the target. Returns NaN when θ₀ is out of range for a column. */
function interpolateColumnToIsentrope(valsByLev, thetasByLev, theta0) {
    const { nlat, nlon } = GRID;
    const N = nlat * nlon;
    const nlev = LEVELS.length;
    const out = new Float32Array(N);
    let vmin = Infinity, vmax = -Infinity;
    for (let idx = 0; idx < N; idx++) {
        let kHi = -1;
        for (let k = 0; k < nlev - 1; k++) {
            const thUp = thetasByLev[k][idx];
            const thLo = thetasByLev[k + 1][idx];
            if (Number.isFinite(thUp) && Number.isFinite(thLo) &&
                thUp >= theta0 && theta0 > thLo) {
                kHi = k; break;
            }
        }
        if (kHi < 0) { out[idx] = NaN; continue; }
        const th1 = thetasByLev[kHi][idx];
        const th2 = thetasByLev[kHi + 1][idx];
        const frac = (th1 - theta0) / (th1 - th2);
        const val = valsByLev[kHi][idx] + frac * (valsByLev[kHi + 1][idx] - valsByLev[kHi][idx]);
        out[idx] = val;
        if (Number.isFinite(val)) {
            if (val < vmin) vmin = val;
            if (val > vmax) vmax = val;
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    return { values: out, vmin, vmax };
}

/** Return a named pressure-level field interpolated to the θ₀ isentropic
 *  surface. Caches the result keyed by (name, month, θ₀). Returns null if
 *  any required T or field tile is missing. Colorbar range (vmin/vmax) is
 *  aggregated across every cached month at the same (name, θ₀) so scrubbing
 *  months doesn't rescale the colormap. */
function fieldOnIsentrope(name, month, theta0) {
    // Opportunistic fill across all 12 months — needed for the cross-month
    // aggregate to be complete and the colorbar to stay stable as you scrub.
    for (let m = 1; m <= 12; m++) {
        const ck = `${name}:${m}:${theta0}`;
        if (_isenFieldCache.has(ck)) continue;
        // Need t at every level (for θ cube) AND the field tile at every level.
        let allHere = true;
        for (const L of LEVELS) {
            if (!cachedMonth('t', m, L) || !cachedMonth(name, m, L)) {
                allHere = false; break;
            }
        }
        if (!allHere) continue;
        const thetas = buildThetaCube(m);
        if (!thetas) continue;
        const valsByLev = [];
        for (const L of LEVELS) valsByLev.push(cachedMonth(name, m, L));
        _isenFieldCache.set(ck, interpolateColumnToIsentrope(valsByLev, thetas, theta0));
    }

    const key = `${name}:${month}:${theta0}`;
    let entry = _isenFieldCache.get(key);
    if (!entry) {
        const thetas = buildThetaCube(month);
        if (!thetas) return null;
        const valsByLev = [];
        for (let k = 0; k < LEVELS.length; k++) {
            const tile = requestEra5(name, { month, level: LEVELS[k] });
            if (!tile) return null;
            valsByLev.push(tile.values);
        }
        entry = interpolateColumnToIsentrope(valsByLev, thetas, theta0);
        _isenFieldCache.set(key, entry);
    }
    // Aggregate range across every cached month at (name, θ₀).
    let vmin = Infinity, vmax = -Infinity;
    for (const [k, v] of _isenFieldCache) {
        if (!k.startsWith(`${name}:`) || !k.endsWith(`:${theta0}`)) continue;
        if (v.vmin < vmin) vmin = v.vmin;
        if (v.vmax > vmax) vmax = v.vmax;
    }
    return {
        values: entry.values,
        vmin: Number.isFinite(vmin) ? vmin : entry.vmin,
        vmax: Number.isFinite(vmax) ? vmax : entry.vmax,
    };
}

/** Relative vorticity ζ on a 1° lat/lon grid. Centred differences; zonal
 *  wrap; forward/backward at lat boundaries; output is zero at the exact
 *  poles. Input u, v are Float32Array shape (nlat*nlon). */
function relativeVorticityFromUV(u, v, nlat, nlon) {
    const out = new Float32Array(nlat * nlon);
    const dLam = Math.PI / 180;           // 1°
    const dPhi = Math.PI / 180;
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        const phi = lat * Math.PI / 180;
        const cosphi = Math.cos(phi);
        // Skip exact poles — metric terms blow up; PV there is not meaningful.
        if (Math.abs(lat) >= 89.5 || cosphi < 1e-6) {
            for (let j = 0; j < nlon; j++) out[i * nlon + j] = 0;
            continue;
        }
        // ∂(u·cosφ)/∂φ uses the neighbouring latitude rows' u·cosφ.
        const iN = Math.max(0, i - 1);
        const iS = Math.min(nlat - 1, i + 1);
        const phiN = (90 - iN) * Math.PI / 180;
        const phiS = (90 - iS) * Math.PI / 180;
        const cosN = Math.cos(phiN);
        const cosS = Math.cos(phiS);
        const dPhiEff = (phiN - phiS);     // positive; N is bigger φ
        for (let j = 0; j < nlon; j++) {
            const jE = (j + 1) % nlon;
            const jW = (j - 1 + nlon) % nlon;
            const dvdlam = (v[i * nlon + jE] - v[i * nlon + jW]) / (2 * dLam);
            const ucosN = u[iN * nlon + j] * cosN;
            const ucosS = u[iS * nlon + j] * cosS;
            const ducosdphi = (ucosN - ucosS) / dPhiEff;
            out[i * nlon + j] = (dvdlam - ducosdphi) / (A_EARTH_PV * cosphi);
        }
    }
    return out;
}

/** Invalidate every θ-coord cache — called when a new pressure-level tile
 *  lands so the next render uses the freshest data. */
export function invalidateIsentropicCache() {
    _pvCache.clear();
    _thetaCubeCache.clear();
    _isenFieldCache.clear();
    _wspdCache.clear();
    _mseCache.clear();
}
// Legacy name kept for callers that still import it.
export const invalidatePVCache = invalidateIsentropicCache;

function computePVOnIsentrope(month, theta0) {
    // Opportunistic fill: compute PV for any month whose t/u/v tiles are all
    // already cached, so the aggregate colorbar stays stable as the user scrubs.
    for (let m = 1; m <= 12; m++) {
        const ck = `${m}:${theta0}`;
        if (_pvCache.has(ck) && _pvCache.get(ck).ready) continue;
        let allHere = true;
        for (const L of LEVELS) {
            if (!cachedMonth('t', m, L) || !cachedMonth('u', m, L) || !cachedMonth('v', m, L)) {
                allHere = false; break;
            }
        }
        if (!allHere) continue;
        _pvComputeRaw(m, theta0);
    }

    const cacheKey = `${month}:${theta0}`;
    let cached = _pvCache.get(cacheKey);
    if (!cached?.ready) {
        cached = _pvComputeRaw(month, theta0);
        if (!cached) return null;
    }
    // Aggregate range across every cached month at this θ₀.
    let vmin = Infinity, vmax = -Infinity;
    for (const [k, v] of _pvCache) {
        if (!k.endsWith(`:${theta0}`) || !v.ready) continue;
        if (v.vmin < vmin) vmin = v.vmin;
        if (v.vmax > vmax) vmax = v.vmax;
    }
    return {
        ...cached,
        vmin: Number.isFinite(vmin) ? vmin : cached.vmin,
        vmax: Number.isFinite(vmax) ? vmax : cached.vmax,
    };
}

/** PV computation for a single (month, θ₀) — returns the cached entry or null
 *  if any required tile is missing. Caches its result. */
function _pvComputeRaw(month, theta0) {
    const thetas = buildThetaCube(month);
    if (!thetas) return null;

    const { nlat, nlon } = GRID;
    const N = nlat * nlon;
    const nlev = LEVELS.length;

    // Fetch u, v tiles on every pressure level (for ζ).
    const vos = [];
    for (let k = 0; k < nlev; k++) {
        const tU = requestEra5('u', { month, level: LEVELS[k] });
        const tV = requestEra5('v', { month, level: LEVELS[k] });
        if (!tU || !tV) return null;
        vos.push(relativeVorticityFromUV(tU.values, tV.values, nlat, nlon));
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

    const interp = interpolateColumnToIsentrope(pvLevs, thetas, theta0);

    // Clamp display range for readability — stratospheric intrusions can
    // blow up the limits to hundreds of PVU; cap around ±10 so the
    // tropospheric ribbon keeps its contrast.
    const DISPLAY_CAP = 10;
    const result = {
        values: interp.values,
        vmin: Math.max(interp.vmin, -DISPLAY_CAP),
        vmax: Math.min(interp.vmax,  DISPLAY_CAP),
        shape: [nlat, nlon], isReal: true, ready: true,
    };
    _pvCache.set(`${month}:${theta0}`, result);
    return result;
    // (Cross-month aggregation now happens in computePVOnIsentrope.)
}

/** True if ERA5 has the listed level (or sl fields w/ no level required). */
export function hasRealLevel(name, level) {
    const meta = FIELDS[name];
    if (!meta) return false;
    if (meta.type === 'sl') return true;
    const levels = availableLevels(name);
    return !!(levels && levels.includes(level));
}
