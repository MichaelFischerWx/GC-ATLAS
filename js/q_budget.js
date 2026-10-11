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
// The terms come from tracer_budget.js (shared with the H budget): below
// ground left out (Boer 1982), the mean circulation mass-corrected (zero net
// mass flux, ω from continuity), finite volume on the air layers. A level
// with less than a quarter of its circle above ground is blank. ∫dp/g of
// the meridional terms is the convergence of the MMC and stationary-eddy
// column moisture transports; the vertical terms integrate to zero; the
// column mean divides by [p_s]/g.

import { sourceMonth, sourceLevels } from './diag_source.js';
import { GRID } from './data.js';
import { tracerBudget, profileAbsMax } from './tracer_budget.js';

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
    // LEVELS, plus 400 and 600 hPa where the tree has them (diag_source.js).
    const P = sourceLevels([srcSlice], ['v', 'w', 'q']);
    const N = P.length;

    const V = [], W = [], Q = [];
    for (let k = 0; k < N; k++) {
        const v = sourceMonth('v', month, P[k], srcSlice, seasonal);
        const w = sourceMonth('w', month, P[k], srcSlice, seasonal);
        const q = sourceMonth('q', month, P[k], srcSlice, seasonal);
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

    // Per unit mass (kg/kg/s) and, in `col`, ∫dp/g over the air (kg/m²/s);
    // implied source (E − P) = −total.
    return { ...tracerBudget(V, W, Q, SP, P), N, nlat, levels: P,
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
    const { nlat } = t;

    if (term === 'all' && (mode === '1d_mean' || mode === '1d_int')) {
        return buildAllTermsProfile(t, form, mode === '1d_int' ? 'integral' : 'mean');
    }

    const arr_si = t[term];
    if (!arr_si) return null;

    // SI units of arr_si: kg/kg/s (per unit mass moisture tendency), shown
    // in g/kg/day in both forms: 1 (kg/kg)/s × 1000 g/kg × 86400 s/day. The
    // column-water rate (mm/day) is the ∫dp/g view.
    const toDisplay = (v) => Number.isFinite(v) ? v * 1000 * DAY_SEC : NaN;
    const unitsLabel = 'g kg⁻¹ day⁻¹';
    const nameLabel  = `Q budget · ${TERM_LABELS[term]}`;

    if (mode === '1d_mean') {
        // Mass-weighted mean over the air column: ∫dp/g ÷ [p_s]/g.
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) prof[i] = toDisplay(t.col[term][i] / t.colMass[i]);
        let absMax = profileAbsMax([prof]);
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
        // Vertical integral in mm/day water-equivalent: ∫ ∂q/∂t · (1/g) dp
        // is in kg/m²/s, and 1 kg/m² = 1 mm of water.
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) prof[i] = t.col[term][i] * DAY_SEC;
        let absMax = profileAbsMax([prof]);
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
    const out = arr_si.map(toDisplay);
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
        levels: t.levels.slice(),
        ground: t.ground,
        name: nameLabel,
        units: unitsLabel,
        isSymmetric: true, isDiagnostic: true,
    };
}

function buildAllTermsProfile(terms, form, agg) {
    const { nlat, col, colMass } = terms;        // colMass = [p_s]/g, kg/m²
    const month = terms._month;
    const seasonal = terms._seasonal ?? false;   // false | true | annual window
    const srcSlice = terms._source ?? null;

    // kg/m²/s → the view's unit: mm/day of water (∫dp/g; 1 kg/m² = 1 mm), or
    // spread over the air column (÷ [p_s]/g) as a q tendency in g/kg/day.
    const conv = (kgs, i) => {
        if (!Number.isFinite(kgs)) return NaN;
        if (agg === 'integral') return kgs * DAY_SEC;
        return kgs / colMass[i] * 1000 * DAY_SEC;
    };

    // The vertical terms integrate to zero over the column (nothing
    // crosses the top or the ground): only the meridional ones are drawn.
    const seriesKeys = ['meanY', 'eddyY', 'total'];
    const profiles = {};
    for (const key of seriesKeys) {
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) prof[i] = conv(col[key][i], i);
        profiles[key] = prof;
    }

    // E - P overlay if surface tiles cached.
    const evap   = month ? evaporationProfile(month, seasonal, srcSlice)   : null;
    const precip = month ? precipitationProfile(month, seasonal, srcSlice) : null;
    const surfaceLines = [];
    if (evap || precip) {
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
    }
    let absMax = profileAbsMax([...seriesKeys.map((k) => profiles[k]),
                                ...surfaceLines.map((s) => s.values)]);

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

