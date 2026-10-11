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
// Below ground (air_mask.js): the zonal means and eddy covariances count
// only cells above the surface (Boer 1982), a level with less than a quarter
// of its circle above ground is blank, and ∂/∂y, ∂/∂p are one-sided next to
// one. Column views weight each level by the air it holds, down to the
// surface: ∫dp/g is the zonal mean of the column integrals, and the column
// mean divides by [p_s], not 1000 hPa. (ERA5's below-ground ω and h made the
// unmasked Jan ∫dp/g "mean vertical" −590 W m⁻² at 30°N and −2400 near 70°S.)

import { sourceMonth } from './diag_source.js';
import { LEVELS, GRID } from './data.js';
import { airZonalMean, airZonalCov, airLayers, columnSum, columnMass,
         ddy, ddp, smoothLat, smoothLev, groundCells } from './air_mask.js';

const A_EARTH = 6.371e6;
const G       = 9.80665;
const D2R     = Math.PI / 180;
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
    const N = LEVELS.length;

    const V = [], W = [], H = [];
    for (let k = 0; k < N; k++) {
        const v = sourceMonth('v', month, LEVELS[k], srcSlice, seasonal);
        const w = sourceMonth('w', month, LEVELS[k], srcSlice, seasonal);
        const t = sourceMonth('t', month, LEVELS[k], srcSlice, seasonal);
        const z = sourceMonth('z', month, LEVELS[k], srcSlice, seasonal);
        const q = sourceMonth('q', month, LEVELS[k], srcSlice, seasonal);
        if (!v || !w || !t || !z || !q) return null;
        V.push(v); W.push(w);
        H.push(composeMSETile(t, z, q));
    }
    const SP = sourceMonth('sp', month, null, srcSlice, seasonal);   // hPa
    if (!SP) return null;

    const cosphi = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) cosphi[i] = Math.cos((90 - i) * D2R);

    // The fluxes the terms differentiate, [k * nlat + i], from zonal means and
    // eddy covariances over the air (NaN where the level doesn't take part):
    // [v][h] cos φ, [ω][h], [v*h*] cos φ, [ω*h*].
    const fluxVH = new Float32Array(N * nlat);
    const fluxWH = new Float32Array(N * nlat);
    const fluxVHe = new Float32Array(N * nlat);
    const fluxWHe = new Float32Array(N * nlat);
    for (let k = 0; k < N; k++) {
        const p = LEVELS[k];
        const vb = airZonalMean(V[k], SP, p);
        const wb = airZonalMean(W[k], SP, p);
        const hb = airZonalMean(H[k], SP, p);
        const vh = airZonalCov(V[k], H[k], vb, hb, SP, p);
        const wh = airZonalCov(W[k], H[k], wb, hb, SP, p);
        for (let i = 0; i < nlat; i++) {
            const idx = k * nlat + i;
            fluxVH[idx]  = vb[i] * hb[i] * cosphi[i];
            fluxWH[idx]  = wb[i] * hb[i];
            fluxVHe[idx] = vh[i] * cosphi[i];
            fluxWHe[idx] = wh[i];
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
            if (c < 1e-3 || !Number.isFinite(fluxVH[idx])) {
                meanY[idx] = NaN; meanP[idx] = NaN;
                eddyY[idx] = NaN; eddyP[idx] = NaN;
                continue;
            }
            meanY[idx] = -ddy(fluxVH, k, i) / c;
            meanP[idx] = -ddp(fluxWH, k, i);
            eddyY[idx] = -ddy(fluxVHe, k, i) / c;
            eddyP[idx] = -ddp(fluxWHe, k, i);
        }
    }

    // Total = sum; implied heating = -total. Blank where no term is
    // (underground, the poles).
    const total  = new Float32Array(N * nlat);
    const source = new Float32Array(N * nlat);
    for (let i = 0; i < N * nlat; i++) {
        let s = 0, any = false;
        for (const t of [meanY[i], meanP[i], eddyY[i], eddyP[i]]) {
            if (Number.isFinite(t)) { s += t; any = true; }
        }
        total[i]  = any ? s : NaN;
        source[i] = any ? -s : NaN;
    }

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
    const { N, nlat, cosphi } = t;

    if (term === 'all' && (mode === '1d_mean' || mode === '1d_int')) {
        return buildAllTermsProfile(t, form, mode === '1d_int' ? 'integral' : 'mean');
    }

    const arr_si = t[term];
    if (!arr_si) return null;

    // arr_si is per-mass MSE tendency (J/kg/s). Convert to display unit.
    //   form='h': K/day  ⇒  arr_si / cp · DAY_SEC
    //   form='H': J/(kg·day) (display same form, vertical integral handles W/m²)
    const out = new Float32Array(arr_si.length);
    for (let i = 0; i < arr_si.length; i++) {
        const v = arr_si[i];
        if (form === 'h') {
            out[i] = Number.isFinite(v) ? (v / CP) * DAY_SEC : NaN;
        } else {
            // H form: scale by 1e-3 to put per-day MSE in kJ/kg/day for readability.
            out[i] = Number.isFinite(v) ? v * DAY_SEC / 1e3 : NaN;
        }
    }
    const unitsLabel = form === 'h' ? 'K day⁻¹' : 'kJ kg⁻¹ day⁻¹';
    const nameLabel  = `H budget · ${TERM_LABELS[term]}`;

    if (mode === '1d_mean') {
        // Mass-weighted mean over the air column.
        const sum = columnSum(out, t.layers);
        const colMass = columnMass(t.layers);
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) prof[i] = sum[i] / colMass[i];
        let absMax = 0;
        for (const v of prof) if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
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
        // Vertical integral ∫ ∂h/∂t · (1/g) dp in W/m² (= J/m²/s), over the air.
        const sum = columnSum(arr_si, t.layers);
        const prof = new Float32Array(nlat);
        let absMax = 0;
        for (let i = 0; i < nlat; i++) {
            const s = sum[i] * 100 / G;
            prof[i] = s;          // already W/m² (J/(kg·s) · kg/m² = W/m²)
            if (Number.isFinite(s) && Math.abs(s) > absMax) absMax = Math.abs(s);
        }
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
        // Σ ∂h/∂t · layers over the air column (J/kg/s × hPa).
        const sum = columnSum(terms[key], layers);
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            if (agg === 'integral') {
                prof[i] = sum[i] * 100 / G;          // → W/m²
            } else {
                // Column-mean K/day if form='h', kJ/kg/day if form='H'.
                const m = sum[i] / colMass[i];
                prof[i] = (form === 'h') ? (m / CP) * DAY_SEC : m * DAY_SEC / 1e3;
            }
            if (Number.isFinite(prof[i]) && Math.abs(prof[i]) > absMax) absMax = Math.abs(prof[i]);
        }
        profiles[key] = prof;
    }

    // Surface heating overlays (W/m² intrinsic).
    const surf = month ? surfaceHeatingProfiles(month, seasonal, srcSlice) : null;
    const surfaceLines = [];
    if (surf) {
        const conv = (wm2, i) => {
            if (!Number.isFinite(wm2)) return NaN;
            if (agg === 'integral') return wm2;
            const p_s = colMass[i] * 100;        // [p_s], Pa
            // For column-mean K/day: wm2 (W/m²) ÷ (mass·cp) = wm2·g/(p_s·cp) (K/s) → ×DAY_SEC
            if (form === 'h') return wm2 * G / (p_s * CP) * DAY_SEC;
            // For kJ/kg/day: wm2 ÷ mass × DAY/1e3
            return wm2 * G / p_s * DAY_SEC / 1e3;
        };
        const make = (arr, key) => {
            const v = new Float32Array(nlat);
            for (let i = 0; i < nlat; i++) v[i] = conv(arr[i], i);
            surfaceLines.push({ values: v, color: SERIES_COLORS[key].color, label: SERIES_COLORS[key].label });
        };
        make(surf.turb, 'turb');
        if (surf.rad) make(surf.rad, 'rad');
        if (surf.tot) make(surf.tot, 'qNet');
        for (const s of surfaceLines) {
            for (const v of s.values) {
                if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
            }
        }
    }

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

