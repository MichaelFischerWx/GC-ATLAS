// GC-ATLAS — zonal-mean angular-momentum budget on (lev, lat).
//
// Per-unit-mass tendency:
//
//   ∂[M]/∂t = -(1/(a cosφ))·∂([v][M] cosφ)/∂y - ∂([ω][M])/∂p     mean transport
//             -(1/(a cosφ))·∂([v*M*] cosφ)/∂y - ∂([ω*M*])/∂p     stationary eddy
//             + F_λ · a cosφ                                       (friction + torque)
//
// where M = (Ω a cosφ + [u]) · a cosφ.
//
// In monthly-mean steady state ∂[M]/∂t ≈ 0, so we report the implied
// surface torque as the residual = -(sum of the four computed terms).
// Stationary eddies only — transients need daily data.
//
// We expose the result in TWO display forms (toggle in the panel):
//   form='u': ∂[u]/∂t = (1/(a cosφ)) ∂[M]/∂t in m/s/day  — most pedagogical
//   form='M': ∂[M]/∂t scaled to 10⁶ m²/s/day so numbers are O(1)
//
// And TWO display modes (toggle in the panel):
//   '2d': cross-section heatmap on (lev, lat)
//   '1d': mass-weighted vertical mean (1/p_s)·∫ T dp → latitude profile

import { sourceMonth } from './diag_source.js';
import { LEVELS, GRID } from './data.js';

const A_EARTH = 6.371e6;
const OMEGA   = 7.2921e-5;
const G       = 9.80665;
const D2R     = Math.PI / 180;
const DAY_SEC = 86400;

function zonalMean(tile, nlat, nlon) {
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let s = 0, n = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const v = tile[row + j];
            if (Number.isFinite(v)) { s += v; n += 1; }
        }
        out[i] = n > 0 ? s / n : NaN;
    }
    return out;
}

/** Zonal-mean covariance [a*b*] = [ab] - [a][b]. NaN-safe. */
function zonalCov(tA, tB, mA, mB, nlat, nlon) {
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let s = 0, n = 0;
        const row = i * nlon;
        const ma = mA[i], mb = mB[i];
        if (!Number.isFinite(ma) || !Number.isFinite(mb)) { out[i] = NaN; continue; }
        for (let j = 0; j < nlon; j++) {
            const a = tA[row + j], b = tB[row + j];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            s += (a - ma) * (b - mb);
            n++;
        }
        out[i] = n > 0 ? s / n : NaN;
    }
    return out;
}

/**
 * Compute the four budget terms + total + implied torque, in raw SI units
 * (m²/s² for ∂[M]/∂t per unit mass). Returns null if any tile is missing.
 */
function computeMBudgetTerms(month, seasonal = false, srcSlice = null) {
    const { nlat, nlon } = GRID;
    const N = LEVELS.length;

    const U = [], V = [], W = [];
    for (let k = 0; k < N; k++) {
        const u = sourceMonth('u', month, LEVELS[k], srcSlice, seasonal);
        const v = sourceMonth('v', month, LEVELS[k], srcSlice, seasonal);
        const w = sourceMonth('w', month, LEVELS[k], srcSlice, seasonal);
        if (!u || !v || !w) return null;
        U.push(u); V.push(v); W.push(w);
    }

    const cosphi = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) cosphi[i] = Math.cos((90 - i) * D2R);

    const Uzm = [], Vzm = [], Wzm = [];
    const uvE = [], uwE = [];
    for (let k = 0; k < N; k++) {
        const ub = zonalMean(U[k], nlat, nlon);
        const vb = zonalMean(V[k], nlat, nlon);
        const wb = zonalMean(W[k], nlat, nlon);
        Uzm.push(ub); Vzm.push(vb); Wzm.push(wb);
        uvE.push(zonalCov(U[k], V[k], ub, vb, nlat, nlon));
        uwE.push(zonalCov(U[k], W[k], ub, wb, nlat, nlon));
    }

    // M(k, i) = (Ω·a·cosφ + [u])·a·cosφ
    const M_zm = new Array(N);
    for (let k = 0; k < N; k++) {
        const Mk = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            const c = cosphi[i];
            Mk[i] = (OMEGA * A_EARTH * c + Uzm[k][i]) * A_EARTH * c;
        }
        M_zm[k] = Mk;
    }

    const meanY = new Float32Array(N * nlat);
    const meanP = new Float32Array(N * nlat);
    const eddyY = new Float32Array(N * nlat);
    const eddyP = new Float32Array(N * nlat);

    for (let k = 0; k < N; k++) {
        for (let i = 0; i < nlat; i++) {
            const c = cosphi[i];
            const idx = k * nlat + i;
            if (c < 1e-3) {
                meanY[idx] = NaN; meanP[idx] = NaN;
                eddyY[idx] = NaN; eddyP[idx] = NaN;
                continue;
            }

            const iN = Math.max(0, i - 1);
            const iS = Math.min(nlat - 1, i + 1);
            const dy_m = A_EARTH * (iS - iN) * D2R;       // northward arc length

            // Mean meridional: -(1/(a cosφ))·∂([v][M] cosφ)/∂φ
            //   With dy = a·dφ this becomes -(1/cosφ)·∂([v][M] cosφ)/∂y.
            //   (Only ONE factor of a cancels — earlier draft erroneously
            //   divided by a·cosφ, killing the term by ~1.6e-7.)
            const fmN = Vzm[k][iN] * M_zm[k][iN] * cosphi[iN];
            const fmS = Vzm[k][iS] * M_zm[k][iS] * cosphi[iS];
            meanY[idx] = -((fmN - fmS) / dy_m) / c;

            // Mean vertical: -∂([ω][M])/∂p
            let dWM_dp;
            if (k === 0) {
                const dp = (LEVELS[1] - LEVELS[0]) * 100;
                dWM_dp = (Wzm[1][i] * M_zm[1][i] - Wzm[0][i] * M_zm[0][i]) / dp;
            } else if (k === N - 1) {
                const dp = (LEVELS[N - 1] - LEVELS[N - 2]) * 100;
                dWM_dp = (Wzm[N - 1][i] * M_zm[N - 1][i] - Wzm[N - 2][i] * M_zm[N - 2][i]) / dp;
            } else {
                const dp = (LEVELS[k + 1] - LEVELS[k - 1]) * 100;
                dWM_dp = (Wzm[k + 1][i] * M_zm[k + 1][i] - Wzm[k - 1][i] * M_zm[k - 1][i]) / dp;
            }
            meanP[idx] = -dWM_dp;

            // Eddy meridional: -(1/(a cosφ))·∂([v*M*] cosφ)/∂φ
            //   With M* = a·cosφ·u*, [v*M*] cosφ = a·cos²φ·[v*u*].
            //   In metric form: -(a/cosφ)·∂(cos²φ·[v*u*])/∂y.
            const eYN = cosphi[iN] * cosphi[iN] * uvE[k][iN];
            const eYS = cosphi[iS] * cosphi[iS] * uvE[k][iS];
            eddyY[idx] = -A_EARTH * ((eYN - eYS) / dy_m) / c;

            // Eddy vertical: -∂([ω*M*])/∂p = -a·cosφ·∂[ω*u*]/∂p
            let duw_dp;
            if (k === 0) {
                const dp = (LEVELS[1] - LEVELS[0]) * 100;
                duw_dp = (uwE[1][i] - uwE[0][i]) / dp;
            } else if (k === N - 1) {
                const dp = (LEVELS[N - 1] - LEVELS[N - 2]) * 100;
                duw_dp = (uwE[N - 1][i] - uwE[N - 2][i]) / dp;
            } else {
                const dp = (LEVELS[k + 1] - LEVELS[k - 1]) * 100;
                duw_dp = (uwE[k + 1][i] - uwE[k - 1][i]) / dp;
            }
            eddyP[idx] = -A_EARTH * c * duw_dp;
        }
    }

    // Total = sum; implied torque = -total (steady-state residual).
    const total  = new Float32Array(N * nlat);
    const torque = new Float32Array(N * nlat);
    for (let i = 0; i < N * nlat; i++) {
        const my = Number.isFinite(meanY[i]) ? meanY[i] : 0;
        const mp = Number.isFinite(meanP[i]) ? meanP[i] : 0;
        const ey = Number.isFinite(eddyY[i]) ? eddyY[i] : 0;
        const ep = Number.isFinite(eddyP[i]) ? eddyP[i] : 0;
        const s = my + mp + ey + ep;
        total[i]  = s;
        torque[i] = -s;
    }

    // Smoothing — derivatives of u/v/w on a 1° grid amplify noise, especially
    // near the poles where 1/cosφ blows up. We apply a 5-point binomial
    // smoother in latitude (3 passes ≈ Gaussian σ ~ 4° lat) AND a single pass
    // in pressure to suppress speckle from level-to-level noise. The budget
    // is still a *residual* of large terms, so this is essential for
    // readability without obscuring the meridional structure that matters.
    for (let pass = 0; pass < 3; pass++) {
        smoothLat(meanY,  N, nlat);
        smoothLat(meanP,  N, nlat);
        smoothLat(eddyY,  N, nlat);
        smoothLat(eddyP,  N, nlat);
        smoothLat(total,  N, nlat);
        smoothLat(torque, N, nlat);
    }
    smoothLev(meanY,  N, nlat);
    smoothLev(meanP,  N, nlat);
    smoothLev(eddyY,  N, nlat);
    smoothLev(eddyP,  N, nlat);
    smoothLev(total,  N, nlat);
    smoothLev(torque, N, nlat);

    return { meanY, meanP, eddyY, eddyP, total, torque, N, nlat, cosphi, _month: month, _seasonal: seasonal, _source: srcSlice };
}

/** Build a multi-series 1D profile with one line per budget term.
 *  Returned shape mirrors the single-line zm but adds zm.series so the
 *  renderer can draw multiple traces with a small legend. */
function buildAllTermsProfile(terms, form, agg = 'mean') {
    const { N, nlat, cosphi } = terms;
    const p_s = LEVELS[N - 1] * 100;

    const seriesKeys = ['meanY', 'meanP', 'eddyY', 'eddyP', 'total'];
    const profiles = {};
    let absMax = 0;

    for (const key of seriesKeys) {
        const arr_si = terms[key];                    // raw m²/s² per unit mass
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            const c = cosphi[i];
            let s = 0;
            for (let k = 0; k < N - 1; k++) {
                const aSI = arr_si[k * nlat + i];
                const bSI = arr_si[(k + 1) * nlat + i];
                if (!Number.isFinite(aSI) || !Number.isFinite(bSI)) continue;
                const dp = (LEVELS[k + 1] - LEVELS[k]) * 100;
                let aDisp, bDisp;
                if (form === 'u') {
                    if (c < 1e-3) continue;
                    // u-tendency m/s² then × DAY_SEC for /day, then column avg or integral.
                    aDisp = (aSI / (A_EARTH * c)) * DAY_SEC;
                    bDisp = (bSI / (A_EARTH * c)) * DAY_SEC;
                } else {
                    // M-form: scaled per-day rate.
                    aDisp = aSI * DAY_SEC / 1e6;
                    bDisp = bSI * DAY_SEC / 1e6;
                }
                if (agg === 'integral') {
                    // Mass per area (kg/m²) = dp/g; multiply per-day tendency by it,
                    // then divide by DAY_SEC to recover per-second SI integrand,
                    // giving stress (N/m²) for u-form.
                    s += 0.5 * (aDisp + bDisp) * dp / G / DAY_SEC;
                } else {
                    s += 0.5 * (aDisp + bDisp) * dp;
                }
            }
            prof[i] = (agg === 'integral') ? s : s / p_s;
            if (Number.isFinite(prof[i]) && Math.abs(prof[i]) > absMax) absMax = Math.abs(prof[i]);
        }
        profiles[key] = prof;
    }

    let units, suffix;
    if (agg === 'integral') {
        // M form: the integrand above carries the 10⁶ display scaling.
        units  = form === 'u' ? 'N m⁻²' : '10⁶ kg s⁻²';
        suffix = '· vertical integral';
    } else {
        units  = form === 'u' ? 'm s⁻¹ day⁻¹' : '10⁶ m² s⁻¹ day⁻¹';
        suffix = '· column-mean';
    }

    if (agg === 'integral') {
        if (absMax < 0.01) absMax = 0.01;
        if (absMax > 5)    absMax = 5;
    } else {
        if (absMax < (form === 'u' ? 0.05 : 0.5)) absMax = form === 'u' ? 0.05 : 0.5;
        const cap = form === 'u' ? 15 : 100;
        if (absMax > cap) absMax = cap;
    }

    // Friction and mountain torques as latitude profiles (single-level diags).
    // Both are intrinsically in N/m² — we convert to whatever the active
    // aggregation expects so the legend lines share a y-axis. Returns null
    // if the ews / oro tiles haven't been built yet, in which case the
    // overlay simply omits those lines (graceful fallback).
    const torqueLines = computeTorqueOverlays(terms, form, agg);
    const allSeries = seriesKeys.map((k) => ({
        values: profiles[k],
        color:  SERIES_COLORS[k].color,
        label:  SERIES_COLORS[k].label,
    }));
    if (torqueLines) {
        for (const t of torqueLines) {
            allSeries.push(t);
            for (const v of t.values) {
                if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
            }
        }
    }

    return {
        kind: 'zonal',
        type: 'sl',
        values: profiles.total,
        vmin: -absMax,
        vmax:  absMax,
        name: `M budget · all terms ${suffix}`,
        units,
        isSymmetric: true,
        isDiagnostic: true,
        series: allSeries,
    };
}

/** Prepare friction + mountain + (sum) overlay series in the active display
 *  units. Returns null if neither tile is yet built.
 *
 *  Both profiles arrive as zonal-mean forces per unit area on the air, F
 *  (N m⁻²). They are put in the budget terms' units the same way:
 *    ∂[u]/∂t form uses F itself; ∂[M]/∂t form uses the torque per unit area
 *    about the axis, T = F · a cosφ (N m⁻¹ = kg s⁻²), scaled by 10⁻⁶ like the
 *    M-form terms;
 *    column mean: spread over the column's mass p_s/g → (·)·g/p_s per second,
 *    × 86400 per day;  ∫dp/g: F in N m⁻², T in 10⁶ kg s⁻². */
function computeTorqueOverlays(terms, form, agg) {
    const { nlat, cosphi } = terms;
    const month = terms._month;
    const seasonal = !!terms._seasonal;
    const srcSlice = terms._source ?? null;
    if (!month) return null;
    const fric = frictionTorqueProfile(month, seasonal, srcSlice);    // N/m² or null
    const mtn  = mountainTorqueProfile(month, seasonal, srcSlice);    // N/m² or null
    if (!fric && !mtn) return null;

    const p_s = LEVELS[LEVELS.length - 1] * 100;
    const conv = (F, i) => {
        if (!Number.isFinite(F)) return NaN;
        const x = form === 'u' ? F : F * A_EARTH * cosphi[i] / 1e6;
        return agg === 'integral' ? x : x * G / p_s * DAY_SEC;
    };

    const out = [];
    if (fric) {
        const f = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) f[i] = conv(fric[i], i);
        out.push({ values: f, color: SERIES_COLORS.friction.color, label: SERIES_COLORS.friction.label });
    }
    if (mtn) {
        const m = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) m[i] = conv(mtn[i], i);
        out.push({ values: m, color: SERIES_COLORS.mountain.color, label: SERIES_COLORS.mountain.label });
    }
    if (fric && mtn) {
        const sum = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            const a = fric[i], b = mtn[i];
            sum[i] = (Number.isFinite(a) && Number.isFinite(b)) ? conv(a + b, i) : NaN;
        }
        out.push({ values: sum, color: SERIES_COLORS.fricMtn.color, label: SERIES_COLORS.fricMtn.label });
    }
    return out;
}

/** In-place 5-point binomial smoother across latitude on a (N × nlat) grid.
 *  Weights [1, 4, 6, 4, 1]/16. NaN-safe (skipped neighbours don't contribute). */
function smoothLat(arr, N, nlat) {
    const tmp = new Float32Array(nlat);
    const W = [1, 4, 6, 4, 1];
    for (let k = 0; k < N; k++) {
        const off = k * nlat;
        for (let i = 0; i < nlat; i++) {
            let s = 0, w = 0;
            for (let m = -2; m <= 2; m++) {
                const ii = i + m;
                if (ii < 0 || ii >= nlat) continue;
                const v = arr[off + ii];
                if (!Number.isFinite(v)) continue;
                s += v * W[m + 2];
                w += W[m + 2];
            }
            tmp[i] = w > 0 ? s / w : NaN;
        }
        for (let i = 0; i < nlat; i++) arr[off + i] = tmp[i];
    }
}

/** In-place 3-point binomial smoother across pressure (level index). */
function smoothLev(arr, N, nlat) {
    const tmp = new Float32Array(N);
    for (let i = 0; i < nlat; i++) {
        for (let k = 0; k < N; k++) {
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
            tmp[k] = w > 0 ? s / w : NaN;
        }
        for (let k = 0; k < N; k++) arr[k * nlat + i] = tmp[k];
    }
}

const TERM_LABELS = {
    total:  'total',
    meanY:  'mean meridional',
    meanP:  'mean vertical',
    eddyY:  'eddy meridional',
    eddyP:  'eddy vertical',
    torque: 'implied torque',
};

/**
 * Build a renderable cross-section / latitude-profile for the chosen term + form + mode.
 *
 * @param {number} month
 * @param {object} opts
 *   term: 'total' | 'meanY' | 'meanP' | 'eddyY' | 'eddyP' | 'torque'
 *   form: 'u' | 'M'  — display variable: ∂[u]/∂t (m s⁻¹ day⁻¹) or ∂[M]/∂t (10⁶ m² s⁻¹ day⁻¹)
 *   mode: '2d' | '1d' — heatmap on (lev, lat) or mass-weighted vertical mean → lat profile
 */
// Plot colors for the "All terms" overlay.
const SERIES_COLORS = {
    meanY:    { color: '#5A9CE0', label: 'mean meridional' },
    meanP:    { color: '#9B59B6', label: 'mean vertical' },
    eddyY:    { color: '#E08A4D', label: 'eddy meridional' },
    eddyP:    { color: '#D44E5E', label: 'eddy vertical' },
    torque:   { color: '#88BFA0', label: 'implied torque' },
    total:    { color: '#E8C26A', label: 'total' },
    friction: { color: '#3FBFD9', label: 'friction (−[ews])' },
    mountain: { color: '#C97AC2', label: 'mountain (−[p_s ∂h/∂x])' },
    fricMtn:  { color: '#F0F0F0', label: 'friction + mountain' },
};

// ── Surface torques on the atmosphere ───────────────────────────────────
// Conventions after Peixoto & Oort (1992, ch. 11) and Newton (1971). Both
// profiles are zonal-mean ZONAL FORCES PER UNIT AREA ON THE AIR, F (N m⁻²),
// positive when they add westerly momentum; the torque per unit area about
// the axis is T = F · a cosφ (N m⁻¹), and globally
//   T_F = 2πa² ∫ T_f cosφ dφ,   T_M = −a² ∫∫ p_s (∂h/∂λ) cosφ dλ dφ.
// computeTorqueOverlays puts F (∂[u]/∂t form) or T (∂[M]/∂t form) in the
// budget terms' units.

/**
 * Friction: F_f(φ) = −[τ_E] in N m⁻², τ_E = ERA5 eastward turbulent surface
 * stress (ewss ÷ 86400, turbulent + orographic form drag), the stress the air
 * exerts ON the surface — positive under surface westerlies. The air feels
 * the opposite stress: a sink of westerly momentum under the midlatitude
 * westerlies (F_f < 0), a source under the trades (F_f > 0).
 *
 * Returns Float32Array(nlat) in N/m², or null if the ews tile isn't cached.
 */
function frictionTorqueProfile(month, seasonal = false, srcSlice = null) {
    const { nlat, nlon } = GRID;
    const ews = sourceMonth('ews', month, null, srcSlice, seasonal);
    if (!ews) return null;
    const out = zonalMean(ews, nlat, nlon);
    for (let i = 0; i < nlat; i++) out[i] = -out[i];   // stress on the air
    return out;
}

/**
 * Mountain: F_m(φ) = −[p_s ∂h/∂x] = −[p_s ∂h/∂λ] / (a cosφ) in N m⁻², the
 * zonal pressure force the topography h(λ, φ) exerts on the air (around a
 * latitude circle −∮∫ ∂p/∂x dz dx = −∮ p_s ∂h/∂x dx). Higher surface pressure
 * on a mountain's west (windward) slope than on its east slope pushes the
 * air westward: F_m < 0, a sink of westerly momentum. Per unit area the
 * torque is T_m = F_m · a cosφ = −[p_s ∂h/∂λ].
 *
 * Numerics: the hydrostatic part of p_s, a function of h alone, contributes
 * nothing analytically (p_ref(h) ∂h/∂λ = ∂(−p₀H e^{−h/H})/∂λ integrates to zero
 * around the circle), but centred differences over steep 1° terrain turn it
 * into a spurious −2.8×10¹⁹ N m global torque. It is removed before
 * differencing (p_s − p₀ e^{−h/H}, p₀ = 1013.25 hPa, H = 8 km); then friction
 * + mountain integrate to ≈ −0.1×10¹⁹ N m globally in the 1991–2020 annual
 * mean (each ≈ ±0.9×10¹⁹), the near-zero total a steady AAM requires. Monthly
 * means are exact here: h is fixed, so the term is linear in p_s.
 *
 * Returns Float32Array(nlat) in N/m², or null if either tile is missing.
 */
const P_REF = 101325;   // Pa
const H_REF = 8000;     // m, isothermal scale height
function mountainTorqueProfile(month, seasonal = false, srcSlice = null) {
    const { nlat, nlon } = GRID;
    const sp_hPa = sourceMonth('sp', month, null, srcSlice, seasonal);
    const oro    = sourceMonth('oro', month, null, srcSlice, seasonal);
    if (!sp_hPa || !oro) return null;

    const out = new Float32Array(nlat);
    const dlam = (2 * Math.PI) / nlon;     // longitude step in radians

    for (let i = 0; i < nlat; i++) {
        const c = Math.cos((90 - i) * D2R);
        if (c < 1e-3) { out[i] = NaN; continue; }
        let s = 0, n = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const jE = (j + 1) % nlon;
            const jW = (j - 1 + nlon) % nlon;
            const dh_dlam = (oro[row + jE] - oro[row + jW]) / (2 * dlam);   // m/rad
            const h = oro[row + j];
            const ps = sp_hPa[row + j] * 100 - P_REF * Math.exp(-h / H_REF);   // Pa, hydrostatic part removed
            if (!Number.isFinite(dh_dlam) || !Number.isFinite(ps)) continue;
            s += ps * dh_dlam;
            n += 1;
        }
        out[i] = n > 0 ? -(s / n) / (A_EARTH * c) : NaN;   // −[p_s ∂h/∂λ]/(a cosφ)
    }
    return out;
}

export function buildMBudgetView(month, opts = {}) {
    const term = opts.term || 'total';
    const form = opts.form || 'u';
    const mode = opts.mode || '2d';
    const seasonal = !!opts.seasonal;

    const t = computeMBudgetTerms(month, seasonal, opts.source ?? null);
    if (!t) return null;
    const { N, nlat, cosphi } = t;

    // "All terms overlay" — only meaningful in 1D mode. Build a multi-series
    // line plot with one trace per term.
    if (term === 'all' && (mode === '1d' || mode === '1d_mean' || mode === '1d_int')) {
        return buildAllTermsProfile(t, form, mode === '1d_int' ? 'integral' : 'mean');
    }

    const arr_si = t[term];
    if (!arr_si) return null;

    // Convert raw m²/s² → display unit
    const out = new Float32Array(arr_si.length);
    if (form === 'u') {
        for (let k = 0; k < N; k++) {
            for (let i = 0; i < nlat; i++) {
                const c = cosphi[i];
                const idx = k * nlat + i;
                const v = arr_si[idx];
                out[idx] = (c > 1e-3 && Number.isFinite(v))
                    ? (v / (A_EARTH * c)) * DAY_SEC
                    : NaN;
            }
        }
    } else {
        // ∂[M]/∂t in 10⁶ m²/s/day (M itself is m²/s; per-day rate scaled by 10⁶ for readability)
        for (let i = 0; i < arr_si.length; i++) {
            const v = arr_si[i];
            out[i] = Number.isFinite(v) ? v * DAY_SEC / 1e6 : NaN;
        }
    }

    const unitsLabel = form === 'u' ? 'm s⁻¹ day⁻¹' : '10⁶ m² s⁻¹ day⁻¹';
    const nameLabel  = `M budget · ${TERM_LABELS[term]}`;

    if (mode === '1d_mean' || mode === '1d') {
        // Mass-weighted vertical mean — keeps display units the same (column avg).
        const p_s = LEVELS[N - 1] * 100;
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            let s = 0;
            for (let k = 0; k < N - 1; k++) {
                const a = out[k * nlat + i];
                const b = out[(k + 1) * nlat + i];
                if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                const dp = (LEVELS[k + 1] - LEVELS[k]) * 100;
                s += 0.5 * (a + b) * dp;
            }
            prof[i] = s / p_s;
        }
        let absMax = 0;
        for (const v of prof) if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
        if (absMax < 0.05) absMax = 0.05;
        return {
            kind: 'zonal',
            type: 'sl',
            values: prof,
            vmin: -absMax,
            vmax:  absMax,
            name: nameLabel + ' · column-mean',
            units: unitsLabel,
            isSymmetric: true,
            isDiagnostic: true,
        };
    }

    if (mode === '1d_int') {
        // Vertical integral ∫ T(p) · dp/g  — units N/m² for u-form (directly
        // comparable to surface friction stress, ~0.1 N/m² typical).
        // For u-form, out is in m/s/day; convert back to per-second (m/s²) for
        // the integral, then × time? Actually we want the integrated tendency
        // in units of stress: ∫ ρ·∂u/∂t dz = ∫ ∂u/∂t · (1/g) dp [N/m²].
        // The arr_si we have is the raw per-mass tendency (m²/s² or m/s²).
        // Easier: compute the integral directly from arr_si in SI to avoid
        // double-conversion artefacts, then label appropriately.
        const prof = new Float32Array(nlat);
        let absMax = 0;
        for (let i = 0; i < nlat; i++) {
            let s = 0;
            for (let k = 0; k < N - 1; k++) {
                const a_si = arr_si[k * nlat + i];
                const b_si = arr_si[(k + 1) * nlat + i];
                if (!Number.isFinite(a_si) || !Number.isFinite(b_si)) continue;
                const dp = (LEVELS[k + 1] - LEVELS[k]) * 100;
                // Convert raw (m²/s²) → u-form (m/s²) by /(a·cosφ); then × dp/g
                // gives (m/s²)·(kg/m²) = N/m². The cosφ factor is per-i, hoist.
                const c = cosphi[i];
                if (c < 1e-3) continue;
                const a_u = (form === 'u') ? a_si / (A_EARTH * c) : a_si;
                const b_u = (form === 'u') ? b_si / (A_EARTH * c) : b_si;
                s += 0.5 * (a_u + b_u) * dp / G;
            }
            prof[i] = s;
            if (Number.isFinite(s) && Math.abs(s) > absMax) absMax = Math.abs(s);
        }
        // u-form: N/m². M-form: kg·m/s² per m² · m = kg/s² (less intuitive); we
        // keep the same path but label appropriately.
        const intUnits = form === 'u' ? 'N m⁻²' : 'kg s⁻² (∂[M]/∂t · dp/g)';
        if (absMax < 0.01) absMax = 0.01;
        return {
            kind: 'zonal',
            type: 'sl',
            values: prof,
            vmin: -absMax,
            vmax:  absMax,
            name: nameLabel + ' · vertical integral',
            units: intUnits,
            isSymmetric: true,
            isDiagnostic: true,
        };
    }

    // 2D heatmap. 95th-percentile of |values| for the colorbar so residual
    // polar spikes don't squash the interior dynamic range.
    const finiteAbs = [];
    for (const v of out) if (Number.isFinite(v)) finiteAbs.push(Math.abs(v));
    finiteAbs.sort((a, b) => a - b);
    let absMax = finiteAbs.length > 0
        ? finiteAbs[Math.floor(0.95 * (finiteAbs.length - 1))]
        : 1;
    const cap = form === 'u' ? 30 : 200;     // m/s/day vs 10⁶ m²/s/day
    if (absMax > cap) absMax = cap;
    if (absMax < (form === 'u' ? 0.3 : 2)) absMax = form === 'u' ? 0.3 : 2;

    return {
        kind: 'zonal',
        type: 'pl',
        values: out,
        vmin: -absMax,
        vmax:  absMax,
        levels: LEVELS.slice(),
        name: nameLabel,
        units: unitsLabel,
        isSymmetric: true,
        isDiagnostic: true,
    };
}
