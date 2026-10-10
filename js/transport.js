// GC-ATLAS — meridional energy and moisture transport across latitude circles.
//
// Energy, northward positive, in PW:
//
//   total   T(φ)  = ∫ from the South Pole to φ of ∮ (R_TOA − ⟨R_TOA⟩) a² cosφ dλ dφ
//                   R_TOA = tsr + ttr (net down at TOA). Removing the global
//                   mean ⟨R_TOA⟩ makes T vanish at both poles.
//   atmos   F_A(φ) = ∮ vitoen a cosφ dλ, mass-corrected (below). ERA5's
//                   vertical integral of the total-energy flux
//                   (c_pT + Φ + L_v q + k)·v is computed on model levels every
//                   hour, so its monthly mean includes the transient eddies.
//   ocean   T − F_A, the residual. For a single month or season it also holds
//                   the surface (mostly ocean) heat-storage tendency.
//
//   F_A = mean meridional circulation + stationary eddies + transient eddies
//     MMC  ∮∫ [v][s] dp/g     s = c_pT + gz + L_v q from the monthly-mean
//     SE   ∮∫ [v*s*] dp/g     v, T, z, q on the pressure levels — the same
//                             [·] / * split the H and Q budgets use, here
//                             mass-weighted and masked below ground
//     TE   ≈ F_A − (MMC + SE)  everything the monthly means miss: sub-monthly
//                             eddies, plus interannual covariance and the
//                             error of 12 pressure levels against 137 model
//                             levels (so: trust it where it is large).
//
// Moisture: the same with q in place of s (kg s⁻¹, shown as L_v·F in PW), and
// the transport implied by the surface E − P − ∂(TCWV)/∂t south of φ in place
// of the TOA one. E = −slhf/L_v, P = tp (ERA5 short-range forecasts).
//
// Mass correction (Trenberth 1997). Reanalysis column mass fluxes do not
// satisfy the mass budget, and a net mass flux M across a latitude circle
// carries energy at the column-mean Ē ≈ 3×10⁵ J kg⁻¹ — 10⁹ kg s⁻¹ of spurious
// mass flux is 0.3 PW. We add the barotropic (vertically and zonally uniform)
// meridional wind that brings M to what the mass budget allows: the
// water-vapour flux plus the dry-mass tendency south of φ. It carries Ē(φ)
// (and q̄ for moisture), the mass-weighted mean over the latitude circle's
// cross-section. Applied to the ERA5 integrals and, separately, to the
// pressure-level MMC (stationary eddies carry no net mass). TE does not depend
// on the target M: it cancels between F_A and MMC.
//
// Seasonal and annual means average the monthly decompositions, so the
// transient term stays sub-monthly: the seasonal cycle of the Hadley cells
// belongs to the MMC, not to "transients".

import { cachedMonth, getManifest, getActivePeriod, activePeriodLabel, windowSlots } from './era5.js';
import { LEVELS, GRID } from './data.js';
import { sourceMonth, sourceKey, sourceWindow } from './diag_source.js';

const A_EARTH = 6.371e6;
const G       = 9.80665;
const CP      = 1004;              // J kg⁻¹ K⁻¹ (as in h_budget.js)
const L_V     = 2.501e6;           // J kg⁻¹
const D2R     = Math.PI / 180;
const DAY     = 86400;
const MONTH_SEC = 365.2425 / 12 * DAY;
const PW      = 1e15;

// era5.js converts these at load; undo it to work in SI.
const GW_PER_M    = 1e9;           // vitoen: W m⁻¹ → displayed in 10⁹ W m⁻¹
const KT_PER_M_S  = 1e3;           // viman:  kg m⁻¹ s⁻¹ → displayed in 10³ kg m⁻¹ s⁻¹
const HPA         = 100;           // sp: Pa → hPa
const Q_TO_SI     = 1e-3;          // q: kg/kg → g/kg

/** Tiles the transport panel reads. sp + tcwv are also needed one month
 *  either side (climatology) for the mass and moisture storage tendencies. */
export const TRANSPORT_INGREDIENTS = {
    pl: ['v', 't', 'z', 'q'],
    sl: ['tsr', 'ttr', 'vitoen', 'viman', 'viwvn', 'sp', 'tcwv', 'slhf', 'tp'],
};
// Single-level tiles that only exist once the energy-transport pipeline has
// run for a tree (configs/era5_variables.yaml, 2026-10).
const NEW_SL = ['tsr', 'vitoen', 'viman', 'viwvn'];

const { nlat: NLAT, nlon: NLON } = GRID;
const NLEV = LEVELS.length;
const DLAM = 2 * Math.PI / NLON;

// Latitude-circle geometry. Row i is the point latitude 90 − i; its grid box
// spans ±0.5°. CELL = area of one box; CELL_S = the part south of the point,
// so a southward-cumulative integral can stop exactly at the row's latitude.
const COS    = new Float64Array(NLAT);
const CELL   = new Float64Array(NLAT);
const CELL_S = new Float64Array(NLAT);
for (let i = 0; i < NLAT; i++) {
    const lat = 90 - i;
    COS[i] = (i === 0 || i === NLAT - 1) ? 0 : Math.cos(lat * D2R);
    const n = Math.min(90, lat + 0.5) * D2R;
    const s = Math.max(-90, lat - 0.5) * D2R;
    CELL[i]   = A_EARTH * A_EARTH * DLAM * (Math.sin(n) - Math.sin(s));
    CELL_S[i] = A_EARTH * A_EARTH * DLAM * (Math.sin(lat * D2R) - Math.sin(s));
}
// Pressure-layer edges between the levels (hPa).
const HALF = LEVELS.slice(0, -1).map((p, k) => 0.5 * (p + LEVELS[k + 1]));

/** NaN-safe Σ_j of row i (missing points filled with the row mean). */
function rowSum(tile, i) {
    let s = 0, n = 0;
    const off = i * NLON;
    for (let j = 0; j < NLON; j++) {
        const v = tile[off + j];
        if (Number.isFinite(v)) { s += v; n += 1; }
    }
    return n > 0 ? s * NLON / n : NaN;
}

/** ∮ X a cosφ dλ for every row — X per unit length (e.g. W m⁻¹) → W. */
function zonalIntegral(tile, scale = 1) {
    const out = new Float64Array(NLAT);
    for (let i = 0; i < NLAT; i++) {
        out[i] = COS[i] === 0 ? 0 : rowSum(tile, i) * A_EARTH * COS[i] * DLAM * scale;
    }
    return out;
}

/** Northward transport implied by a source field X (per unit area, e.g.
 *  W m⁻²): ∫∫ (X − ⟨X⟩) dA over the cap south of each row's latitude.
 *  `rows[i]` = Σ_j X_ij. Returns { transport, globalMean }. */
function impliedFromSouth(rows) {
    let tot = 0, area = 0;
    for (let i = 0; i < NLAT; i++) { tot += rows[i] * CELL[i]; area += NLON * CELL[i]; }
    const mean = tot / area;
    const out = new Float64Array(NLAT);
    let acc = 0;
    for (let i = NLAT - 1; i >= 0; i--) {
        const r = rows[i] - NLON * mean;
        out[i] = acc + r * CELL_S[i];
        acc += r * CELL[i];
    }
    return { transport: out, globalMean: mean };
}

function rowsOf(tile, f = null) {
    const out = new Float64Array(NLAT);
    for (let i = 0; i < NLAT; i++) out[i] = rowSum(tile, i);
    if (f) for (let i = 0; i < NLAT; i++) out[i] = f(out[i]);
    return out;
}

/** Monthly-mean flow on pressure levels, per latitude row: the resolved
 *  column fluxes ∮∫ v·s dp/g and ∮∫ v·q dp/g, their mean-meridional parts,
 *  the net mass flux, and the cross-section means Ē and q̄.
 *
 *  Vertical quadrature: level k stands for the layer between the midpoints
 *  to its neighbours. Levels below the surface get no weight and the lowest
 *  level above it reaches down to p_s, so every column holds exactly p_s/g
 *  of air (ERA5 extrapolates below ground — those values never enter). */
function pressureLevelFluxes(V, T, Z, Q, SP) {
    const resS = new Float64Array(NLAT), resQ = new Float64Array(NLAT);
    const mmcS = new Float64Array(NLAT), mmcQ = new Float64Array(NLAT);
    const mRes = new Float64Array(NLAT);
    const eBar = new Float64Array(NLAT), qBar = new Float64Array(NLAT);
    const Wk = new Float64Array(NLEV), Vk = new Float64Array(NLEV);
    const Sk = new Float64Array(NLEV), Qk = new Float64Array(NLEV);
    for (let i = 0; i < NLAT; i++) {
        Wk.fill(0); Vk.fill(0); Sk.fill(0); Qk.fill(0);
        let sVS = 0, sVQ = 0, sV = 0, sS = 0, sQ = 0, sW = 0;
        const off = i * NLON;
        for (let j = 0; j < NLON; j++) {
            const idx = off + j;
            const ps = SP[idx];                       // hPa
            if (!(ps > LEVELS[0])) continue;
            let kb = 0;
            while (kb + 1 < NLEV && LEVELS[kb + 1] <= ps) kb++;
            for (let k = 0; k <= kb; k++) {
                const v = V[k][idx], t = T[k][idx], z = Z[k][idx], qg = Q[k][idx];
                if (!Number.isFinite(v) || !Number.isFinite(t)
                    || !Number.isFinite(z) || !Number.isFinite(qg)) continue;
                const top = k === 0 ? 0 : HALF[k - 1];
                const bot = k === kb ? ps : HALF[k];
                const w = (bot - top) * HPA;                // Pa
                const q = qg * Q_TO_SI;
                const s = CP * t + G * z + L_V * q;         // z is height (m)
                Wk[k] += w; Vk[k] += w * v; Sk[k] += w * s; Qk[k] += w * q;
                sVS += w * v * s; sVQ += w * v * q; sV += w * v;
                sS += w * s; sQ += w * q; sW += w;
            }
        }
        let mS = 0, mQ = 0;
        for (let k = 0; k < NLEV; k++) {
            if (Wk[k] > 0) { mS += Vk[k] * Sk[k] / Wk[k]; mQ += Vk[k] * Qk[k] / Wk[k]; }
        }
        const scale = A_EARTH * COS[i] * DLAM / G;
        resS[i] = sVS * scale; resQ[i] = sVQ * scale; mRes[i] = sV * scale;
        mmcS[i] = mS * scale;  mmcQ[i] = mQ * scale;
        eBar[i] = sW > 0 ? sS / sW : NaN;
        qBar[i] = sW > 0 ? sQ / sW : NaN;
    }
    return { resS, resQ, mmcS, mmcQ, mRes, eBar, qBar };
}

/** Centred climatological tendency (per second) of the per-area field
 *  f(sp, tcwv) at `month`, as row sums. Null until m ± 1 are cached. */
function climoTendencyRows(month, f, climo) {
    const prev = ((month + 10) % 12) + 1;
    const next = (month % 12) + 1;
    const spP = climo('sp', prev), spN = climo('sp', next);
    const twP = climo('tcwv', prev), twN = climo('tcwv', next);
    if (!spP || !spN || !twP || !twN) return null;
    const out = new Float64Array(NLAT);
    for (let i = 0; i < NLAT; i++) {
        let s = 0, n = 0;
        const off = i * NLON;
        for (let j = 0; j < NLON; j++) {
            const idx = off + j;
            const d = f(spN[idx], twN[idx]) - f(spP[idx], twP[idx]);
            if (Number.isFinite(d)) { s += d; n += 1; }
        }
        out[i] = n > 0 ? (s * NLON / n) / (2 * MONTH_SEC) : 0;
    }
    return out;
}

const climoMonth = (name, month) => cachedMonth(name, month);

/** All transport terms for one month of `get(name, month, level)`, in W and
 *  kg s⁻¹ per latitude row, or null while a tile is missing. The storage
 *  tendencies come from `climo(name, month)` (the active climatology): the
 *  seasonal cycle, also when `get` reads a single year or a composite. */
export function computeMonthTransport(month, get, climo = climoMonth) {
    const sl = {};
    for (const n of TRANSPORT_INGREDIENTS.sl) {
        if (n === 'tcwv') continue;                 // climatology only (tendencies)
        sl[n] = get(n, month, null);
        if (!sl[n]) return null;
    }
    const V = [], T = [], Z = [], Q = [];
    for (const L of LEVELS) {
        const v = get('v', month, L), t = get('t', month, L);
        const z = get('z', month, L), q = get('q', month, L);
        if (!v || !t || !z || !q) return null;
        V.push(v); T.push(t); Z.push(z); Q.push(q);
    }
    // Dry-air mass p_s/g − TCWV and column water TCWV, from the climatology.
    const dryRows = climoTendencyRows(month, (sp, tw) => sp * HPA / G - tw, climo);
    const wetRows = climoTendencyRows(month, (_sp, tw) => tw, climo);
    if (!dryRows || !wetRows) return null;

    // TOA-implied total: R_TOA = tsr + ttr (both W m⁻², net down).
    const rToa = new Float64Array(NLAT);
    const tsrRows = rowsOf(sl.tsr), ttrRows = rowsOf(sl.ttr);
    for (let i = 0; i < NLAT; i++) rToa[i] = tsrRows[i] + ttrRows[i];
    const toa = impliedFromSouth(rToa);

    // Surface-implied moisture transport: E − P − ∂TCWV/∂t (kg m⁻² s⁻¹).
    const eRows = rowsOf(sl.slhf, (x) => -x / L_V);
    const pRows = rowsOf(sl.tp, (x) => x / DAY);           // mm day⁻¹ = kg m⁻² day⁻¹
    const emp = new Float64Array(NLAT);
    for (let i = 0; i < NLAT; i++) emp[i] = eRows[i] - pRows[i] - wetRows[i];
    const sfcQ = impliedFromSouth(emp);

    // Net northward dry-mass flux the budget requires: −∂/∂t (dry mass south of φ).
    const dryMass = impliedFromSouth(dryRows);
    const fRaw = zonalIntegral(sl.vitoen, GW_PER_M);
    const mRaw = zonalIntegral(sl.viman, KT_PER_M_S);
    const wRaw = zonalIntegral(sl.viwvn);
    const pl = pressureLevelFluxes(V, T, Z, Q, sl.sp);

    const n = () => new Float64Array(NLAT);
    const e = { total: toa.transport, atmos: n(), atmosRaw: fRaw, ocean: n(),
                mmc: n(), se: n(), te: n(), correction: n() };
    const m = { implied: sfcQ.transport, atmos: n(), atmosRaw: wRaw,
                mmc: n(), se: n(), te: n(), correction: n() };
    const mTarget = n();
    for (let i = 0; i < NLAT; i++) {
        const target = wRaw[i] - dryMass.transport[i];
        mTarget[i] = target;
        const eb = pl.eBar[i], qb = pl.qBar[i];
        const dVI  = Number.isFinite(eb) ? (target - mRaw[i]) : 0;
        const dRes = Number.isFinite(eb) ? (target - pl.mRes[i]) : 0;
        e.correction[i] = dVI * (eb || 0);
        e.atmos[i] = fRaw[i] + e.correction[i];
        e.ocean[i] = e.total[i] - e.atmos[i];
        e.mmc[i]   = pl.mmcS[i] + dRes * (eb || 0);
        e.se[i]    = pl.resS[i] - pl.mmcS[i];
        e.te[i]    = e.atmos[i] - e.mmc[i] - e.se[i];
        m.correction[i] = dVI * (qb || 0);
        m.atmos[i] = wRaw[i] + m.correction[i];
        m.mmc[i]   = pl.mmcQ[i] + dRes * (qb || 0);
        m.se[i]    = pl.resQ[i] - pl.mmcQ[i];
        m.te[i]    = m.atmos[i] - m.mmc[i] - m.se[i];
    }
    return {
        energy: e, moisture: m,
        massRaw: mRaw, massRes: pl.mRes, massTarget: mTarget,
        eBar: pl.eBar, qBar: pl.qBar,
        toaGlobalMean: toa.globalMean / NLON,          // W m⁻²
        empGlobalMean: sfcQ.globalMean / NLON,         // kg m⁻² s⁻¹
    };
}

// ── view ─────────────────────────────────────────────────────────────

const _monthCache = new Map();   // `${period}|${source}|${month}` → terms

function monthTerms(month, src) {
    const key = `${getActivePeriod()}|${sourceKey(src)}|${month}`;
    if (_monthCache.has(key)) return _monthCache.get(key);
    const r = computeMonthTransport(month, (name, mo, level) => sourceMonth(name, mo, level, src));
    if (r) _monthCache.set(key, r);
    return r;
}

/** Which of the new single-level tiles the tree behind `src` lacks — the
 *  climatology windows and the per-year tree gain them one rebuild at a
 *  time. Empty once all are there (or before the manifest has loaded). */
export function transportTilesMissing(src = null) {
    const m = getManifest(src ? 'per_year' : getActivePeriod());
    if (!m) return [];
    const have = new Set();
    for (const g of Object.values(m.groups || {})) for (const k of Object.keys(g)) have.add(k);
    return NEW_SL.filter((n) => !have.has(n));
}

/** The averaging window (era5.js windowMonths' `seasonal` option) of a view. */
const transportWindow = (average, seasonal) => (average === 'annual' ? 'annual' : seasonal);

/** Months a view averages over, each with its calendar-year offset
 *  (era5.js windowSlots): a year's DJF takes the December before it. */
export function transportSlots(month, { average = 'month', seasonal = false } = {}) {
    return windowSlots(month, transportWindow(average, seasonal));
}

const COLORS = {
    total:   '#E6EFE9',   // paper
    atmos:   '#2DBDA0',   // emerald-bright
    ocean:   '#D4A84B',   // ochre
    mmc:     '#C97AC2',   // violet
    se:      '#E08A4D',   // clay
    te:      '#D44E5E',   // rose
};
const DASH = [5, 3];

function averaged(terms, pick) {
    const out = new Float64Array(NLAT);
    for (const t of terms) {
        const a = pick(t);
        for (let i = 0; i < NLAT; i++) out[i] += a[i];
    }
    for (let i = 0; i < NLAT; i++) out[i] /= terms.length;
    return out;
}

function peak(arr, sign) {
    let best = 0, lat = NaN;
    for (let i = 0; i < NLAT; i++) {
        const v = arr[i] * sign;
        if (v > best) { best = v; lat = 90 - i; }
    }
    return { value: best * sign, lat };
}

/**
 * Line-plot view for the cross-section panel.
 *   quantity  'energy' | 'moisture'
 *   average   'month' (the displayed month, or its 3-month season when
 *             `seasonal`) | 'annual'
 *   source    diag_source.js descriptor (null = active climatology)
 * Returns null while tiles load, or { unavailable: '…' } when this source
 * can't produce the view.
 */
export function buildTransportView(month, { quantity = 'energy', average = 'month', seasonal = false, source = null } = {}) {
    const missing = transportTilesMissing(source);
    if (missing.length) {
        const tree = source ? 'The per-year archive' : `The ${activePeriodLabel()} climatology`;
        return { unavailable: `${tree} has no ${missing.join(' / ')} tiles yet` };
    }
    if (average === 'annual' && source && source.year == null) {
        return { unavailable: 'Annual means are not offered for composites (12 months × every event year of tiles). Pick a month or a season.' };
    }
    // Each averaged month with the slice to read it from — a year's DJF
    // reads the December before (diag_source.js sourceWindow) — leaving out
    // months the year / composite can't supply.
    const win = sourceWindow(source, month, transportWindow(average, seasonal));
    const months = win.map((w) => w.month);
    if (!months.length) return { unavailable: 'No published months for this selection yet.' };
    const terms = [];
    for (const { month: m, src } of win) {
        const t = monthTerms(m, src);
        if (!t) return null;
        terms.push(t);
    }

    const toUnit = quantity === 'energy' ? 1 / PW : L_V / PW;
    const Q = quantity === 'energy' ? 'energy' : 'moisture';
    const series = [];
    const add = (key, label, opts = {}) => {
        const a = averaged(terms, (t) => t[Q][key]);
        const values = new Float32Array(NLAT);
        for (let i = 0; i < NLAT; i++) values[i] = a[i] * toUnit;
        series.push({ key, values, label, color: COLORS[key === 'implied' ? 'total' : key], ...opts });
        return values;
    };
    const isAnnual = average === 'annual';
    // Storage only cancels over a full year — a year whose later months
    // aren't published yet is still "transport + storage".
    const isPure = months.length === 12;
    if (quantity === 'energy') {
        add('total', isPure ? 'total (TOA)' : 'TOA-implied', { width: 2.5 });
        add('atmos', 'atmosphere', { width: 2.5 });
        add('ocean', isPure ? 'ocean' : 'ocean + storage', { width: 2.5 });
    } else {
        add('implied', 'E − P implied', { width: 2.5 });
        add('atmos', 'atmosphere', { width: 2.5 });
    }
    add('mmc', 'mean merid. circ.', { width: 1.5, dash: DASH });
    add('se',  'stationary eddies', { width: 1.5, dash: DASH });
    add('te',  'transient (resid.)', { width: 1.5, dash: DASH });

    let absMax = 0;
    for (const s of series) {
        for (const v of s.values) if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
    }
    absMax = Math.max(quantity === 'energy' ? 1 : 0.5, Math.ceil(absMax * 1.1 * 2) / 2);

    // Numbers the caption and the console sanity check quote.
    const atm = series.find((s) => s.key === 'atmos').values;
    const corr = averaged(terms, (t) => t[Q].correction);
    let corrMax = 0, corrLat = NaN;
    for (let i = 0; i < NLAT; i++) {
        const c = Math.abs(corr[i] * toUnit);
        if (c > corrMax) { corrMax = c; corrLat = 90 - i; }
    }
    const meanOf = (k) => terms.reduce((s, t) => s + t[k], 0) / terms.length;
    const peaks = {};
    for (const s of series) peaks[s.key] = { N: peak(s.values, +1), S: peak(s.values, -1) };
    const stats = {
        months,
        toaImbalance: meanOf('toaGlobalMean'),                 // W m⁻²
        empImbalance: meanOf('empGlobalMean') * DAY,           // mm day⁻¹
        massCorrectionMax: corrMax, massCorrectionLat: corrLat, // display units
        peaks,
    };

    const label = quantity === 'energy' ? 'Meridional energy transport' : 'Meridional moisture transport';
    return {
        kind: 'zonal', type: 'sl',
        values: atm,
        vmin: -absMax, vmax: absMax,
        name: label,
        units: quantity === 'energy' ? 'PW' : 'PW (L_v·F_q)',
        isSymmetric: true, isDiagnostic: true,
        series,
        legendPos: 'tl',
        transport: { quantity, average, seasonal: !!seasonal && !isAnnual, ...stats },
    };
}
