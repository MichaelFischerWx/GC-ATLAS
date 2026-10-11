// GC-ATLAS — zonal-mean moisture budget on (lev, lat).
//
// Per unit mass:
//   ∂[q]/∂t = -(1/(a cosφ))·∂([v][q] cosφ)/∂y - ∂([ω][q])/∂p     mean transport
//             -(1/(a cosφ))·∂([v*q*] cosφ)/∂y - ∂([ω*q*])/∂p     stationary eddies
//             + (E - P) source from surface (column-integrated)
//
// In monthly steady-state ∂[q]/∂t ≈ 0, so the implied surface source/sink
// (residual) ≈ -[transport] should match the actual E - P (slhf/L_v - tp).
// Stationary eddies only — transients need daily data.
//
// Display forms:
//   form='q':   ∂[q]/∂t per unit mass in g/(kg·day)
//   form='Q':   ∂[Q]/∂t per area scaled to mm/day (column-water equivalent)
//
// Aggregations:
//   '2d':       cross-section heatmap on (lev, lat)
//   '1d_mean':  mass-weighted vertical mean — same units as 2D
//   '1d_int':   vertical integral ∫·dp/g in mm/day equivalent (kg/m²/day H2O)
//
// Surface E-P overlay: when 1D mode + slhf/tp tiles are cached, additional
// lines appear for evaporation E = slhf / L_v, precipitation P = tp, and
// the net E-P that should equal the implied source.
//
// Below ground (air_mask.js): the zonal means and eddy covariances count
// only cells above the surface (Boer 1982), a level with less than a quarter
// of its circle above ground is blank, and ∂/∂y, ∂/∂p are one-sided next to
// one. Column views weight each level by the air it holds, down to the
// surface: ∫dp/g is the zonal mean of the column integrals, and the column
// mean divides by [p_s], not 1000 hPa.

import { sourceMonth } from './diag_source.js';
import { LEVELS, GRID } from './data.js';
import { airZonalMean, airZonalCov, airLayers, columnSum, columnMass,
         ddy, ddp, smoothLat, smoothLev, groundCells } from './air_mask.js';

const A_EARTH = 6.371e6;
const G       = 9.80665;
const D2R     = Math.PI / 180;
const DAY_SEC = 86400;
const L_V     = 2.501e6;       // J/kg, latent heat of vaporisation (~273 K)
// q is stored in g/kg (×1000 from raw kg/kg). Inside this module we convert
// back to kg/kg before computing fluxes — conceptually cleaner.
const Q_TO_SI = 1e-3;

/** Zonal mean over the whole circle, NaN-safe (surface fields). */
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


function computeQBudgetTerms(month, seasonal = false, srcSlice = null) {
    const { nlat } = GRID;
    const N = LEVELS.length;

    const V = [], W = [], Q = [];
    for (let k = 0; k < N; k++) {
        const v = sourceMonth('v', month, LEVELS[k], srcSlice, seasonal);
        const w = sourceMonth('w', month, LEVELS[k], srcSlice, seasonal);
        const q = sourceMonth('q', month, LEVELS[k], srcSlice, seasonal);
        if (!v || !w || !q) return null;
        V.push(v); W.push(w);
        // Convert q from g/kg → kg/kg in-place into a temp tile.
        const qSI = new Float32Array(q.length);
        for (let i = 0; i < q.length; i++) {
            qSI[i] = Number.isFinite(q[i]) ? q[i] * Q_TO_SI : NaN;
        }
        Q.push(qSI);
    }
    const SP = sourceMonth('sp', month, null, srcSlice, seasonal);   // hPa
    if (!SP) return null;

    const cosphi = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) cosphi[i] = Math.cos((90 - i) * D2R);

    // The fluxes the terms differentiate, [k * nlat + i], from zonal means and
    // eddy covariances over the air (NaN where the level doesn't take part):
    // [v][q] cos φ, [ω][q], [v*q*] cos φ, [ω*q*].
    const fluxVQ = new Float32Array(N * nlat);
    const fluxWQ = new Float32Array(N * nlat);
    const fluxVQe = new Float32Array(N * nlat);
    const fluxWQe = new Float32Array(N * nlat);
    for (let k = 0; k < N; k++) {
        const p = LEVELS[k];
        const vb = airZonalMean(V[k], SP, p);
        const wb = airZonalMean(W[k], SP, p);
        const qb = airZonalMean(Q[k], SP, p);
        const vq = airZonalCov(V[k], Q[k], vb, qb, SP, p);
        const wq = airZonalCov(W[k], Q[k], wb, qb, SP, p);
        for (let i = 0; i < nlat; i++) {
            const idx = k * nlat + i;
            fluxVQ[idx]  = vb[i] * qb[i] * cosphi[i];
            fluxWQ[idx]  = wb[i] * qb[i];
            fluxVQe[idx] = vq[i] * cosphi[i];
            fluxWQe[idx] = wq[i];
        }
    }

    const meanY = new Float32Array(N * nlat);
    const meanP = new Float32Array(N * nlat);
    const eddyY = new Float32Array(N * nlat);
    const eddyP = new Float32Array(N * nlat);

    for (let k = 0; k < N; k++) {
        for (let i = 0; i < nlat; i++) {
            const c = cosphi[i];
            const idx = k * nlat + i;
            if (c < 1e-3 || !Number.isFinite(fluxVQ[idx])) {
                meanY[idx] = NaN; meanP[idx] = NaN;
                eddyY[idx] = NaN; eddyP[idx] = NaN;
                continue;
            }

            // Mean meridional: -(1/cosφ)·∂([v][q] cosφ)/∂y  (after dy = a·dφ
            // collapses one factor of a).
            meanY[idx] = -ddy(fluxVQ, k, i) / c;

            // Mean vertical: -∂([ω][q])/∂p
            meanP[idx] = -ddp(fluxWQ, k, i);

            // Eddy meridional: -(1/cosφ)·∂([v*q*] cosφ)/∂y. The cosφ stays
            // as an explicit factor; no extra a appears (q is a scalar, no
            // cos²φ as in M-budget).
            eddyY[idx] = -ddy(fluxVQe, k, i) / c;

            // Eddy vertical: -∂([ω*q*])/∂p
            eddyP[idx] = -ddp(fluxWQe, k, i);
        }
    }

    // Total = sum; implied source = -total. Blank where no term is
    // (underground, the poles).
    const total  = new Float32Array(N * nlat);
    const source = new Float32Array(N * nlat);    // implied source/sink = -total
    for (let i = 0; i < N * nlat; i++) {
        let s = 0, any = false;
        for (const t of [meanY[i], meanP[i], eddyY[i], eddyP[i]]) {
            if (Number.isFinite(t)) { s += t; any = true; }
        }
        total[i]  = any ? s : NaN;
        source[i] = any ? -s : NaN;
    }

    // Smooth (3 lat passes + 1 level pass) — same rationale as M-budget:
    // derivatives on a 1° grid amplify noise.
    for (let pass = 0; pass < 3; pass++) {
        smoothLat(meanY,  N, nlat);
        smoothLat(meanP,  N, nlat);
        smoothLat(eddyY,  N, nlat);
        smoothLat(eddyP,  N, nlat);
        smoothLat(total,  N, nlat);
        smoothLat(source, N, nlat);
    }
    smoothLev(meanY,  N, nlat);
    smoothLev(meanP,  N, nlat);
    smoothLev(eddyY,  N, nlat);
    smoothLev(eddyP,  N, nlat);
    smoothLev(total,  N, nlat);
    smoothLev(source, N, nlat);

    return { meanY, meanP, eddyY, eddyP, total, source, N, nlat, cosphi,
             layers: airLayers(SP), ground: groundCells(SP),
             _month: month, _seasonal: seasonal, _source: srcSlice };
}

const TERM_LABELS = {
    total:  'total',
    meanY:  'mean meridional',
    meanP:  'mean vertical',
    eddyY:  'eddy meridional',
    eddyP:  'eddy vertical',
    source: 'implied source (E−P)',
};

const SERIES_COLORS = {
    meanY:  { color: '#5A9CE0', label: 'mean meridional' },
    meanP:  { color: '#9B59B6', label: 'mean vertical' },
    eddyY:  { color: '#E08A4D', label: 'eddy meridional' },
    eddyP:  { color: '#D44E5E', label: 'eddy vertical' },
    source: { color: '#88BFA0', label: 'implied source' },
    total:  { color: '#E8C26A', label: 'total' },
    evap:   { color: '#3FBFD9', label: 'evaporation E' },
    precip: { color: '#C97AC2', label: 'precipitation P' },
    eMinusP:{ color: '#F0F0F0', label: 'E − P' },
};

/** Surface evaporation profile from slhf (W/m² → kg/m²/s via L_v). Returns
 *  Float32Array(nlat) in kg/m²/s, or null if slhf tile not cached. */
function evaporationProfile(month, seasonal = false, srcSlice = null) {
    const { nlat, nlon } = GRID;
    const slhf = sourceMonth('slhf', month, null, srcSlice, seasonal);
    if (!slhf) return null;
    const zm = zonalMean(slhf, nlat, nlon);
    // slhf is W/m² (already converted from accumulated); positive upward = into
    // atmosphere = positive E. ERA5 convention: slhf is downward, so E = -slhf/L_v.
    // Actually ERA5 surface latent heat flux sign convention: positive downward
    // (into surface). For evaporation FROM surface: E = -slhf / L_v.
    for (let i = 0; i < nlat; i++) {
        zm[i] = Number.isFinite(zm[i]) ? -zm[i] / L_V : NaN;
    }
    return zm;
}

/** Surface precipitation profile from tp (mm/day → kg/m²/s). */
function precipitationProfile(month, seasonal = false, srcSlice = null) {
    const { nlat, nlon } = GRID;
    const tp = sourceMonth('tp', month, null, srcSlice, seasonal);
    if (!tp) return null;
    const zm = zonalMean(tp, nlat, nlon);
    // tp is in mm/day after unit conversion. Convert to kg/m²/s: 1 mm/day ≈
    // 1.1574e-5 kg/m²/s (since 1 mm water depth = 1 kg/m²; per day = /86400).
    for (let i = 0; i < nlat; i++) {
        zm[i] = Number.isFinite(zm[i]) ? zm[i] / DAY_SEC : NaN;
    }
    return zm;
}

export function buildQBudgetView(month, opts = {}) {
    // Accept 'torque' as alias for 'source' so the shared dropdown works.
    let term = opts.term || 'total';
    if (term === 'torque') term = 'source';
    const form = opts.form || 'q';
    const mode = opts.mode || '2d';
    const seasonal = opts.seasonal ?? false;   // false | true (3-month) | annual window

    const t = computeQBudgetTerms(month, seasonal, opts.source ?? null);
    if (!t) return null;
    const { N, nlat, cosphi } = t;

    if (term === 'all' && (mode === '1d_mean' || mode === '1d_int')) {
        return buildAllTermsProfile(t, form, mode === '1d_int' ? 'integral' : 'mean');
    }

    const arr_si = t[term];
    if (!arr_si) return null;

    // SI units of arr_si: kg/kg/s (per unit mass moisture tendency).
    // form='q': display in g/kg/day. form='Q': display in 10⁻³ kg/(kg·day) (same).
    const out = new Float32Array(arr_si.length);
    if (form === 'q') {
        for (let i = 0; i < arr_si.length; i++) {
            const v = arr_si[i];
            // 1 (kg/kg)/s × 1000 g/kg × 86400 s/day = (g/kg)/day
            out[i] = Number.isFinite(v) ? v * 1000 * DAY_SEC : NaN;
        }
    } else {
        // Q form: column-water-equivalent rate. Multiply by p_s/g to get total
        // column mass per area, then × 86400 to get per day, /1000 → mm/day.
        // Same SI input but reported in mm/day · (1/p_s factor) — done in 1d_int path.
        for (let i = 0; i < arr_si.length; i++) {
            const v = arr_si[i];
            out[i] = Number.isFinite(v) ? v * 1000 * DAY_SEC : NaN;
        }
    }

    const unitsLabel = form === 'q' ? 'g kg⁻¹ day⁻¹' : 'g kg⁻¹ day⁻¹';
    const nameLabel  = `Q budget · ${TERM_LABELS[term]}`;

    if (mode === '1d_mean') {
        // Mass-weighted mean over the air column.
        const sum = columnSum(out, t.layers);
        const colMass = columnMass(t.layers);
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) prof[i] = sum[i] / colMass[i];
        let absMax = 0;
        for (const v of prof) if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
        if (absMax < 0.05) absMax = 0.05;
        return {
            kind: 'zonal', type: 'sl',
            values: prof, vmin: -absMax, vmax: absMax,
            name: nameLabel + ' · column-mean',
            units: unitsLabel,
            isSymmetric: true, isDiagnostic: true,
        };
    }

    if (mode === '1d_int') {
        // Vertical integral in mm/day water-equivalent.
        // ∫ ∂q/∂t · (1/g) dp has units (1/s)·(kg/m²) = kg/m²/s. Convert to
        // mm/day: × DAY_SEC then ÷ 1000 (1 kg/m² = 1 mm water).
        const sum = columnSum(arr_si, t.layers);
        const prof = new Float32Array(nlat);
        let absMax = 0;
        for (let i = 0; i < nlat; i++) {
            const s = sum[i] * 100 / G;
            // s in kg/m²/s; × 86400 / 1000 = mm/day water equivalent.
            prof[i] = s * DAY_SEC;
            if (Number.isFinite(prof[i]) && Math.abs(prof[i]) > absMax) absMax = Math.abs(prof[i]);
        }
        if (absMax < 0.5) absMax = 0.5;
        if (absMax > 30) absMax = 30;
        return {
            kind: 'zonal', type: 'sl',
            values: prof, vmin: -absMax, vmax: absMax,
            name: nameLabel + ' · vertical integral',
            units: 'mm day⁻¹',
            isSymmetric: true, isDiagnostic: true,
        };
    }

    // 2D heatmap
    const finiteAbs = [];
    for (const v of out) if (Number.isFinite(v)) finiteAbs.push(Math.abs(v));
    finiteAbs.sort((a, b) => a - b);
    let absMax = finiteAbs.length > 0
        ? finiteAbs[Math.floor(0.95 * (finiteAbs.length - 1))]
        : 1;
    if (absMax < 0.1) absMax = 0.1;
    if (absMax > 5)   absMax = 5;
    return {
        kind: 'zonal', type: 'pl',
        values: out, vmin: -absMax, vmax: absMax,
        levels: LEVELS.slice(),
        ground: t.ground,
        name: nameLabel,
        units: unitsLabel,
        isSymmetric: true, isDiagnostic: true,
    };
}

function buildAllTermsProfile(terms, form, agg) {
    const { nlat, layers } = terms;
    const month = terms._month;
    const seasonal = terms._seasonal ?? false;   // false | true | annual window
    const srcSlice = terms._source ?? null;
    const colMass = columnMass(layers);          // [p_s], hPa

    const seriesKeys = ['meanY', 'meanP', 'eddyY', 'eddyP', 'total'];
    const profiles = {};
    let absMax = 0;

    for (const key of seriesKeys) {
        // Σ ∂q/∂t · layers over the air column (kg/kg/s × hPa).
        const sum = columnSum(terms[key], layers);
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            // ∫dp/g: kg/m²/s → mm/day = × 86400 / 1000 = × 86.4 (1 kg/m² =
            // 1 mm). Column mean: mass-weighted, in g/kg/day.
            prof[i] = (agg === 'integral')
                ? sum[i] * 100 / G * DAY_SEC
                : sum[i] / colMass[i] * 1000 * DAY_SEC;
            if (Number.isFinite(prof[i]) && Math.abs(prof[i]) > absMax) absMax = Math.abs(prof[i]);
        }
        profiles[key] = prof;
    }

    // E - P overlay if surface tiles cached.
    const evap   = month ? evaporationProfile(month, seasonal, srcSlice)   : null;
    const precip = month ? precipitationProfile(month, seasonal, srcSlice) : null;
    const surfaceLines = [];
    if (evap || precip) {
        const conv = (kgs, i) => {
            // kg/m²/s → mm/day
            if (!Number.isFinite(kgs)) return NaN;
            if (agg === 'integral') return kgs * DAY_SEC;
            // Convert surface flux to equivalent column-mean q tendency
            // (g/kg/day): kgs / ([p_s]/g) = (kg/m²/s) / (kg/m²) = 1/s → ×1000×86400.
            return kgs / (colMass[i] * 100 / G) * 1000 * DAY_SEC;
        };
        if (evap) {
            const e = new Float32Array(nlat);
            for (let i = 0; i < nlat; i++) e[i] = conv(evap[i], i);
            surfaceLines.push({ values: e, color: SERIES_COLORS.evap.color, label: SERIES_COLORS.evap.label });
        }
        if (precip) {
            const p = new Float32Array(nlat);
            for (let i = 0; i < nlat; i++) p[i] = conv(precip[i], i);
            surfaceLines.push({ values: p, color: SERIES_COLORS.precip.color, label: SERIES_COLORS.precip.label });
        }
        if (evap && precip) {
            const ep = new Float32Array(nlat);
            for (let i = 0; i < nlat; i++) {
                const a = evap[i], b = precip[i];
                ep[i] = (Number.isFinite(a) && Number.isFinite(b)) ? conv(a - b, i) : NaN;
            }
            surfaceLines.push({ values: ep, color: SERIES_COLORS.eMinusP.color, label: SERIES_COLORS.eMinusP.label });
        }
        for (const s of surfaceLines) {
            for (const v of s.values) {
                if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
            }
        }
    }

    const units = (agg === 'integral') ? 'mm day⁻¹' : 'g kg⁻¹ day⁻¹';
    const suffix = (agg === 'integral') ? '· vertical integral' : '· column-mean';
    if (absMax < (agg === 'integral' ? 0.5 : 0.05)) absMax = (agg === 'integral' ? 0.5 : 0.05);

    return {
        kind: 'zonal', type: 'sl',
        values: profiles.total,
        vmin: -absMax, vmax: absMax,
        name: `Q budget · all terms ${suffix}`,
        units,
        isSymmetric: true, isDiagnostic: true,
        series: [
            ...seriesKeys.map((k) => ({
                values: profiles[k],
                color:  SERIES_COLORS[k].color,
                label:  SERIES_COLORS[k].label,
            })),
            ...surfaceLines,
        ],
    };
}

