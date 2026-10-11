// GC-ATLAS — the air in the zonal-mean (lat, p) diagnostics.
//
// ERA5 fills pressure levels under the surface with extrapolated values
// (Jan 1991–2020: 33 % of the 1000 hPa surface, 9 % at 925, 5 % at 850, 2 %
// at 700). They are not air: below ground ω averages +0.02 to +0.10 Pa/s at
// 700–1000 hPa (< 0.001 over the air there) and T is a lapse-rate
// extrapolation. So, following Boer (1982) as lorenz.js does, a cell counts
// only where p ≤ p_s, the monthly-mean surface pressure (a missing p_s counts
// as air):
//
//   [X]      zonal mean over the above-ground part of the latitude circle
//   [a*b*]   eddy covariance over that part, a* = a − [a]
//   [β]      that part's share of the circle (0 = underground all round)
//
// A level takes part at a latitude only where at least a quarter of the
// circle is above ground (MIN_AIR_SHARE): a "zonal mean" of the few points
// left — the Ross Ice Shelf at 85°S, 925 hPa — is a regional mean, and its
// "eddies" aren't waves. Those cells are blank (hatched as ground) in the
// sections.
//
// The budgets and EP flux difference the zonal means with ∂/∂y and ∂/∂p,
// one-sided next to a latitude or level that doesn't take part. Of the ways
// of handling a circle that is partly underground, this keeps the mass
// budget closest to closing at 500–1000 hPa: the meridional and vertical
// mass-flux divergences of the air-part means cancel better than those of
// the unmasked means, or of Boer's [β]-weighted fluxes divided by [β] (which
// blow up where a level grazes the terrain). Integrals weight a level by the
// air it holds: ψ by [β], column integrals by airLayers, so a latitude's
// ∫dp/g is the zonal mean of the column integrals — what the surface fluxes
// beside it are.

import { LEVELS, GRID } from './data.js';

const A_EARTH = 6.371e6;
const D2R     = Math.PI / 180;

/** Share of a latitude circle that must be above ground for a level to take
 *  part there. */
export const MIN_AIR_SHARE = 0.25;

/** Share of each latitude circle above ground at pressure p (hPa):
 *  Float32Array(nlat). `sp` = surface pressure tile (hPa). */
export function airShare(sp, p) {
    const { nlat, nlon } = GRID;
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let n = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) if (!(p > sp[row + j])) n++;
        out[i] = n / nlon;
    }
    return out;
}

/** Zonal mean of `tile` over the columns with air at pressure p (hPa),
 *  NaN-safe; NaN where they're less than MIN_AIR_SHARE of the circle.
 *  Float32Array(nlat). p is usually the tile's own level; a deeper one
 *  restricts the mean to the columns that reach down to it. */
export function airZonalMean(tile, sp, p) {
    const { nlat, nlon } = GRID;
    const nMin = MIN_AIR_SHARE * nlon;
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let s = 0, n = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            if (p > sp[row + j]) continue;
            const v = tile[row + j];
            if (Number.isFinite(v)) { s += v; n++; }
        }
        out[i] = n >= nMin ? s / n : NaN;
    }
    return out;
}

/** Eddy covariance [a*b*] over the columns with air at pressure p (hPa),
 *  about mA and mB, the airZonalMean of a and b over the same columns
 *  (NaN where those are). Float32Array(nlat). */
export function airZonalCov(tA, tB, mA, mB, sp, p) {
    const { nlat, nlon } = GRID;
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        const ma = mA[i], mb = mB[i];
        if (!Number.isFinite(ma) || !Number.isFinite(mb)) { out[i] = NaN; continue; }
        let s = 0, n = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            if (p > sp[row + j]) continue;
            const a = tA[row + j], b = tB[row + j];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            s += (a - ma) * (b - mb);
            n++;
        }
        out[i] = n > 0 ? s / n : NaN;
    }
    return out;
}

/** hPa of air each level stands for, as a zonal mean over each circle:
 *  Float32Array(nlev × nlat), [k * nlat + i]. Level k's layer runs between
 *  the midpoints to its neighbours (from 0 hPa for the top one); in each
 *  column the deepest level above the surface reaches down to p_s (below
 *  1000 hPa where p_s > 1000) and the levels under it get none — the
 *  transport panel's convention. Σ_k X·layers·100/g = ∫X dp/g over the air,
 *  and Σ_k layers = [p_s]. `levels` (hPa): LEVELS unless the diagnostic
 *  reads more (diag_source.js sourceLevels). */
export function airLayers(sp, levels = LEVELS) {
    const { nlat, nlon } = GRID;
    const N = levels.length;
    const out = new Float32Array(N * nlat);
    for (let i = 0; i < nlat; i++) {
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const ps = sp[row + j];
            const air = Number.isFinite(ps) ? ps : levels[N - 1];
            for (let k = 0; k < N && !(levels[k] > air); k++) {
                const top = k === 0 ? 0 : 0.5 * (levels[k - 1] + levels[k]);
                const deeper = k + 1 < N && !(levels[k + 1] > air);
                const bot = deeper ? 0.5 * (levels[k] + levels[k + 1]) : air;
                out[k * nlat + i] += (bot - top) / nlon;
            }
        }
    }
    return out;
}

/** Column sum over the air at each latitude, Σ_k X·layers (layers from
 *  airLayers, hPa): Float32Array(nlat). Levels without a value add nothing.
 *  × 100/g gives ∫X dp/g; ÷ columnMass the mass-weighted column mean. */
export function columnSum(X, layers) {
    const { nlat } = GRID;
    const N = layers.length / nlat;
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let s = 0;
        for (let k = 0; k < N; k++) {
            const v = X[k * nlat + i];
            if (Number.isFinite(v)) s += v * layers[k * nlat + i];
        }
        out[i] = s;
    }
    return out;
}

/** The air column at each latitude, Σ_k layers = [p_s] (hPa):
 *  Float32Array(nlat). */
export function columnMass(layers) {
    const { nlat } = GRID;
    const N = layers.length / nlat;
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let s = 0;
        for (let k = 0; k < N; k++) s += layers[k * nlat + i];
        out[i] = s;
    }
    return out;
}

/** ∂X/∂y (per metre, northward) of a [k * nlat + i] array at (k, i):
 *  centred; one-sided at the poles and next to a latitude with no value
 *  (NaN); NaN with neither neighbour. */
export function ddy(arr, k, i) {
    const { nlat } = GRID;
    const off = k * nlat;
    let iN = Math.max(0, i - 1);
    let iS = Math.min(nlat - 1, i + 1);
    if (!Number.isFinite(arr[off + iN])) iN = i;
    if (!Number.isFinite(arr[off + iS])) iS = i;
    if (iN === iS) return NaN;
    return (arr[off + iN] - arr[off + iS]) / (A_EARTH * (iS - iN) * D2R);
}

/** ∂X/∂p (per Pa) of a [k * nlat + i] array on `levels` (hPa) at (k, i):
 *  centred; one-sided at the top and bottom levels and next to a level with
 *  no value (NaN); NaN with neither neighbour. */
export function ddp(arr, k, i, levels = LEVELS) {
    const { nlat } = GRID;
    const N = levels.length;
    let kUp = Math.max(0, k - 1);
    let kDn = Math.min(N - 1, k + 1);
    if (!Number.isFinite(arr[kUp * nlat + i])) kUp = k;
    if (!Number.isFinite(arr[kDn * nlat + i])) kDn = k;
    if (kUp === kDn) return NaN;
    return (arr[kDn * nlat + i] - arr[kUp * nlat + i]) / ((levels[kDn] - levels[kUp]) * 100);
}

/** Static stability ∂θ/∂p (K / Pa) at level m of `levels` (hPa) in each
 *  column, = (θ/p) ∂ln θ/∂ln p: the three-point second-order derivative in
 *  ln p at the level; the two-point secant at the top and where the level
 *  below is underground in that column (either is exact for an isothermal
 *  layer, θ ∝ p^−κ); NaN where level m is. TH, LNTH: θ and ln θ tiles per
 *  level. Float32Array(nlat × nlon). θ curves so much in p between these
 *  levels that a secant in p misses the stratification at the level (EP
 *  flux, N²): across 10–50 hPa it was 3½× too small, and at 300 hPa it
 *  spanned 250–500 hPa. */
export function columnStability(TH, LNTH, sp, levels, m) {
    const nlev = levels.length;
    const out = new Float32Array(sp.length);
    const x = levels.map(Math.log);
    let w0 = 0, w1 = 0, w2 = 0;
    if (m > 0 && m + 1 < nlev) {
        const h1 = x[m] - x[m - 1], h2 = x[m + 1] - x[m];
        w0 = -h2 / (h1 * (h1 + h2));
        w1 = (h2 - h1) / (h1 * h2);
        w2 = h1 / (h2 * (h1 + h2));
    }
    const pm = levels[m] * 100;
    for (let idx = 0; idx < sp.length; idx++) {
        const ps = sp[idx];
        if (levels[m] > ps) { out[idx] = NaN; continue; }
        const below = m + 1 < nlev && !(levels[m + 1] > ps);
        let dl;
        if (m > 0 && below) {
            dl = w0 * LNTH[m - 1][idx] + w1 * LNTH[m][idx] + w2 * LNTH[m + 1][idx];
        } else {
            const kUp = m > 0 ? m - 1 : m;
            const kDn = below ? m + 1 : m;
            dl = kUp === kDn ? NaN : (LNTH[kDn][idx] - LNTH[kUp][idx]) / (x[kDn] - x[kUp]);
        }
        out[idx] = TH[m][idx] / pm * dl;
    }
    return out;
}

/** θ and ln θ tiles (θ = T (1000/p)^κ) for the T tiles `T` on `levels`. */
export function thetaTiles(T, levels, kappa) {
    const TH = [], LNTH = [];
    for (let k = 0; k < levels.length; k++) {
        const f = Math.pow(1000 / levels[k], kappa);
        const t = T[k];
        const th = new Float32Array(t.length), ln = new Float32Array(t.length);
        for (let i = 0; i < t.length; i++) {
            th[i] = Number.isFinite(t[i]) ? t[i] * f : NaN;
            ln[i] = Math.log(th[i]);
        }
        TH.push(th); LNTH.push(ln);
    }
    return { TH, LNTH };
}

/** In-place 5-point binomial smoother across latitude on a (N × nlat) grid,
 *  weights [1, 4, 6, 4, 1]/16. NaN-safe: missing neighbours don't count,
 *  and a cell with no value (underground, the poles) stays empty. */
export function smoothLat(arr, N, nlat) {
    const tmp = new Float32Array(nlat);
    const W = [1, 4, 6, 4, 1];
    for (let k = 0; k < N; k++) {
        const off = k * nlat;
        for (let i = 0; i < nlat; i++) {
            if (!Number.isFinite(arr[off + i])) { tmp[i] = NaN; continue; }
            let s = 0, w = 0;
            for (let m = -2; m <= 2; m++) {
                const ii = i + m;
                if (ii < 0 || ii >= nlat) continue;
                const v = arr[off + ii];
                if (!Number.isFinite(v)) continue;
                s += v * W[m + 2];
                w += W[m + 2];
            }
            tmp[i] = s / w;
        }
        for (let i = 0; i < nlat; i++) arr[off + i] = tmp[i];
    }
}

/** In-place 3-point binomial smoother across pressure (level index), same
 *  NaN rules as smoothLat. */
export function smoothLev(arr, N, nlat) {
    const tmp = new Float32Array(N);
    for (let i = 0; i < nlat; i++) {
        for (let k = 0; k < N; k++) {
            if (!Number.isFinite(arr[k * nlat + i])) { tmp[k] = NaN; continue; }
            let s = 0, w = 0;
            for (let m = -1; m <= 1; m++) {
                const kk = k + m;
                if (kk < 0 || kk >= N) continue;
                const v = arr[kk * nlat + i];
                if (!Number.isFinite(v)) continue;
                const wt = m === 0 ? 2 : 1;
                s += v * wt;
                w += wt;
            }
            tmp[k] = s / w;
        }
        for (let k = 0; k < N; k++) arr[k * nlat + i] = tmp[k];
    }
}

/** 1 where less than MIN_AIR_SHARE of the latitude circle is above ground
 *  at the level, else 0: Uint8Array(nlev × nlat), [k * nlat + i], for
 *  `levels` (hPa; LEVELS unless a diagnostic reads more). These cells take
 *  no part in the sections, which hatch them as ground. */
export function groundCells(sp, levels = LEVELS) {
    const { nlat } = GRID;
    const N = levels.length;
    const out = new Uint8Array(N * nlat);
    for (let k = 0; k < N; k++) {
        const sh = airShare(sp, levels[k]);
        for (let i = 0; i < nlat; i++) out[k * nlat + i] = sh[i] >= MIN_AIR_SHARE ? 0 : 1;
    }
    return out;
}
