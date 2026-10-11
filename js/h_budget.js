// GC-ATLAS — zonal-mean moist-static-energy (MSE) budget on (lev, lat).
//
// MSE per unit mass: h = c_p·T + g·z + L_v·q  (J/kg).
//
// Per-mass tendency:
//   ∂[h]/∂t = -(1/(a cosφ))·∂([v][h] cosφ)/∂y - ∂([ω][h])/∂p     mean transport
//             -(1/(a cosφ))·∂([v*h*] cosφ)/∂y - ∂([ω*h*])/∂p     stationary eddies
//             + Q (atmospheric heating from surface fluxes + radiation)
//
// Column-integrated steady-state:
//   ∇·∫h·v dp = LH + SH + R_TOA - R_SFC
//   where LH = -slhf, SH = -sshf, R_TOA = tsr+ttr (net down at top: absorbed
//         solar minus OLR), R_SFC = ssr+str (net down at surface).
//
// Display forms:
//   form='h':  ∂[h]/(c_p·∂t) in K/day (interpretable as a "moist enthalpy
//              tendency in temperature units")
//   form='H':  same SI tendency, vertically integrated to W/m² (canonical
//              column-energy-budget form, directly comparable to surface +
//              TOA fluxes)
//
// Stationary eddies only — transients need daily data.
//
// Surface heating overlay: when 1D mode + slhf/sshf/ssr/str/tsr/ttr tiles
// cached, additional lines appear for LH+SH (turbulent), net column radiation,
// and total surface+TOA atmospheric heating that should equal -[transport].
// Trees built before the tsr tiles existed show the turbulent line only.
//
// The terms come from tracer_budget.js (shared with the Q budget): below
// ground left out (Boer 1982), the mean circulation mass-corrected (zero net
// mass flux, ω from continuity), finite volume on the air layers. A level
// with less than a quarter of its circle above ground is blank. ∫dp/g of
// the meridional terms is the convergence of the MMC and stationary-eddy
// column transports; the vertical terms integrate to zero; the column mean
// divides by [p_s]/g. (ERA5's below-ground ω and h had made the Jan ∫dp/g
// "mean vertical" −590 W m⁻² at 30°N and −2400 near 70°S; the mass
// imbalance then left −640 to +1340 W m⁻² in the Jul total poleward of 80°S.)

import { sourceMonth, sourceLevels } from './diag_source.js';
import { GRID } from './data.js';
import { tracerBudget, profileAbsMax } from './tracer_budget.js';

const G       = 9.80665;
const DAY_SEC = 86400;
const CP      = 1004;          // J/(kg·K)
const L_V     = 2.501e6;       // J/kg
const Q_TO_SI = 1e-3;          // q stored as g/kg → divide by 1000 for kg/kg

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


/** Compose MSE field h = c_p·T + g·z + L_v·q for a single tile. z is already
 *  in m (geopotential height, after era5.js's m²/s² → m conversion). */
function composeMSETile(t, z, q) {
    const out = new Float32Array(t.length);
    for (let i = 0; i < t.length; i++) {
        const T = t[i], Z = z[i], Q = q[i];
        if (!Number.isFinite(T) || !Number.isFinite(Z) || !Number.isFinite(Q)) {
            out[i] = NaN; continue;
        }
        out[i] = CP * T + G * Z + L_V * (Q * Q_TO_SI);
    }
    return out;
}

function computeHBudgetTerms(month, seasonal = false, srcSlice = null) {
    const { nlat } = GRID;
    // LEVELS, plus 400 and 600 hPa where the tree has them (diag_source.js).
    const P = sourceLevels([srcSlice], ['v', 'w', 't', 'z', 'q']);
    const N = P.length;

    const V = [], W = [], H = [];
    for (let k = 0; k < N; k++) {
        const v = sourceMonth('v', month, P[k], srcSlice, seasonal);
        const w = sourceMonth('w', month, P[k], srcSlice, seasonal);
        const t = sourceMonth('t', month, P[k], srcSlice, seasonal);
        const z = sourceMonth('z', month, P[k], srcSlice, seasonal);
        const q = sourceMonth('q', month, P[k], srcSlice, seasonal);
        if (!v || !w || !t || !z || !q) return null;
        V.push(v); W.push(w);
        H.push(composeMSETile(t, z, q));
    }
    const SP = sourceMonth('sp', month, null, srcSlice, seasonal);   // hPa
    if (!SP) return null;

    // Per unit mass (J/kg/s) and, in `col`, ∫dp/g over the air (W/m²);
    // implied heating = −total.
    return { ...tracerBudget(V, W, H, SP, P), N, nlat, levels: P,
             _month: month, _seasonal: seasonal, _source: srcSlice };
}

const TERM_LABELS = {
    total:  'total',
    meanY:  'mean meridional',
    meanP:  'mean vertical',
    eddyY:  'eddy meridional',
    eddyP:  'eddy vertical',
    source: 'implied heating',
};

const SERIES_COLORS = {
    meanY:  { color: '#5A9CE0', label: 'mean meridional' },
    meanP:  { color: '#9B59B6', label: 'mean vertical' },
    eddyY:  { color: '#E08A4D', label: 'eddy meridional' },
    eddyP:  { color: '#D44E5E', label: 'eddy vertical' },
    source: { color: '#88BFA0', label: 'implied heating' },
    total:  { color: '#E8C26A', label: 'total' },
    turb:   { color: '#3FBFD9', label: 'LH + SH (turbulent)' },
    rad:    { color: '#C97AC2', label: 'net column radiation' },
    qNet:   { color: '#F0F0F0', label: 'total atm heating' },
};

/** Atmospheric heating components per latitude in W/m² (column integrated).
 *  Sign convention: positive = atmosphere gains energy. ERA5 surface fluxes
 *  are positive DOWNWARD (into surface), so atmospheric uptake = negation. */
function surfaceHeatingProfiles(month, seasonal = false, srcSlice = null) {
    const { nlat, nlon } = GRID;
    const slhf = sourceMonth('slhf', month, null, srcSlice, seasonal);
    const sshf = sourceMonth('sshf', month, null, srcSlice, seasonal);
    const ssr  = sourceMonth('ssr',  month, null, srcSlice, seasonal);
    const str  = sourceMonth('str',  month, null, srcSlice, seasonal);
    // Net TOA shortwave is the ABSORBED solar (tsr), not the incident tisr:
    // tisr + ttr overstated the column heating by the reflected ~100 W m⁻².
    const tsr  = sourceMonth('tsr',  month, null, srcSlice, seasonal);
    const ttr  = sourceMonth('ttr',  month, null, srcSlice, seasonal);
    if (!slhf || !sshf) return null;

    const slhfZ = zonalMean(slhf, nlat, nlon);
    const sshfZ = zonalMean(sshf, nlat, nlon);
    const turb = new Float32Array(nlat);   // LH + SH atmospheric uptake
    for (let i = 0; i < nlat; i++) {
        // ERA5 slhf / sshf are downward (into sfc); atm gain = −flux.
        turb[i] = -slhfZ[i] - sshfZ[i];
    }
    if (!ssr || !str || !tsr || !ttr) return { turb, rad: null, tot: null };

    const ssrZ = zonalMean(ssr, nlat, nlon);
    const strZ = zonalMean(str, nlat, nlon);
    const tsrZ = zonalMean(tsr, nlat, nlon);
    const ttrZ = zonalMean(ttr, nlat, nlon);
    const rad  = new Float32Array(nlat);   // R_TOA_net - R_SFC_net (atm column net rad)
    const tot  = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        const Rtoa = tsrZ[i] + ttrZ[i];         // net down at TOA
        const Rsfc = ssrZ[i] + strZ[i];         // net down at surface
        rad[i] = Rtoa - Rsfc;                   // atmospheric column net radiation
        tot[i] = turb[i] + rad[i];
    }
    return { turb, rad, tot };
}

export function buildHBudgetView(month, opts = {}) {
    let term = opts.term || 'total';
    if (term === 'torque') term = 'source';
    const form = opts.form || 'h';
    const mode = opts.mode || '2d';
    const seasonal = opts.seasonal ?? false;   // false | true (3-month) | annual window

    const t = computeHBudgetTerms(month, seasonal, opts.source ?? null);
    if (!t) return null;
    const { nlat } = t;

    if (term === 'all' && (mode === '1d_mean' || mode === '1d_int')) {
        return buildAllTermsProfile(t, form, mode === '1d_int' ? 'integral' : 'mean');
    }

    const arr_si = t[term];
    if (!arr_si) return null;

    // Per-mass MSE tendency (J/kg/s) → display unit:
    //   form='h': K/day        (÷ c_p × day)
    //   form='H': kJ/(kg·day)  (× day ÷ 10³; the vertical integral is in W/m²)
    const toDisplay = (v) => !Number.isFinite(v) ? NaN
        : (form === 'h' ? (v / CP) * DAY_SEC : v * DAY_SEC / 1e3);
    const unitsLabel = form === 'h' ? 'K day⁻¹' : 'kJ kg⁻¹ day⁻¹';
    const nameLabel  = `H budget · ${TERM_LABELS[term]}`;

    if (mode === '1d_mean') {
        // Mass-weighted mean over the air column: ∫dp/g ÷ [p_s]/g.
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) prof[i] = toDisplay(t.col[term][i] / t.colMass[i]);
        let absMax = profileAbsMax([prof]);
        if (absMax < 0.1) absMax = 0.1;
        return {
            kind: 'zonal', type: 'sl',
            values: prof, vmin: -absMax, vmax: absMax,
            name: nameLabel + ' · column-mean',
            units: unitsLabel,
            isSymmetric: true, isDiagnostic: true,
        };
    }

    if (mode === '1d_int') {
        // Vertical integral ∫ ∂h/∂t · (1/g) dp over the air, W/m².
        const prof = Float32Array.from(t.col[term]);
        let absMax = profileAbsMax([prof]);
        if (absMax < 5)   absMax = 5;
        if (absMax > 300) absMax = 300;
        return {
            kind: 'zonal', type: 'sl',
            values: prof, vmin: -absMax, vmax: absMax,
            name: nameLabel + ' · vertical integral',
            units: 'W m⁻²',
            isSymmetric: true, isDiagnostic: true,
        };
    }

    // 2D
    const out = arr_si.map(toDisplay);
    const finiteAbs = [];
    for (const v of out) if (Number.isFinite(v)) finiteAbs.push(Math.abs(v));
    finiteAbs.sort((a, b) => a - b);
    let absMax = finiteAbs.length > 0
        ? finiteAbs[Math.floor(0.95 * (finiteAbs.length - 1))]
        : 1;
    if (absMax < (form === 'h' ? 0.5 : 5))  absMax = form === 'h' ? 0.5 : 5;
    if (absMax > (form === 'h' ? 30 : 300)) absMax = form === 'h' ? 30 : 300;
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

    // W/m² → the view's unit: as is (∫dp/g), or spread over the air column
    // (÷ [p_s]/g): K/day if form='h', kJ/kg/day if form='H'.
    const conv = (wm2, i) => {
        if (!Number.isFinite(wm2)) return NaN;
        if (agg === 'integral') return wm2;
        const perMass = wm2 / colMass[i];        // J/kg/s
        return form === 'h' ? perMass / CP * DAY_SEC : perMass * DAY_SEC / 1e3;
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

    // Surface heating overlays (W/m² intrinsic).
    const surf = month ? surfaceHeatingProfiles(month, seasonal, srcSlice) : null;
    const surfaceLines = [];
    if (surf) {
        const make = (arr, key) => {
            const v = new Float32Array(nlat);
            for (let i = 0; i < nlat; i++) v[i] = conv(arr[i], i);
            surfaceLines.push({ values: v, color: SERIES_COLORS[key].color, label: SERIES_COLORS[key].label });
        };
        make(surf.turb, 'turb');
        if (surf.rad) make(surf.rad, 'rad');
        if (surf.tot) make(surf.tot, 'qNet');
    }
    let absMax = profileAbsMax([...seriesKeys.map((k) => profiles[k]),
                                ...surfaceLines.map((s) => s.values)]);

    const units = (agg === 'integral')
        ? 'W m⁻²'
        : (form === 'h' ? 'K day⁻¹' : 'kJ kg⁻¹ day⁻¹');
    const suffix = (agg === 'integral') ? '· vertical integral' : '· column-mean';
    if (absMax < (agg === 'integral' ? 5 : 0.1)) absMax = (agg === 'integral' ? 5 : 0.1);

    return {
        kind: 'zonal', type: 'sl',
        values: profiles.total,
        vmin: -absMax, vmax: absMax,
        name: `H budget · all terms ${suffix}`,
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

