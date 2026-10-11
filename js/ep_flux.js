// GC-ATLAS — stationary-eddy Eliassen–Palm flux on the (lat, p) plane.
//
// From the monthly-mean fields u, v, w, t we form departures from the zonal
// mean ([·] denotes zonal mean):
//
//   u' = u - [u]    v' = v - [v]    θ' = θ - [θ]    where θ = T·(1000/p)^κ
//
// Then in quasi-geostrophic form (Edmon–Hoskins–McIntyre 1980):
//
//   F_φ = -a cos φ · [u'v']
//   F_p =  a cos φ · f · [v'θ'] / (∂[θ]/∂p)
//
// Divergence (the eddy forcing of [u]):
//
//   ∇·F = (1/(a cos φ))·∂(F_φ cos φ)/∂φ + ∂F_p/∂p
//
// IMPORTANT: This is the **stationary-eddy** EP flux — it captures wave
// activity carried by the time-mean field's longitudinal departures
// (e.g. planetary waves locked to topography / land–sea contrast). It does
// NOT include the transient-eddy contribution, which would require daily
// data. Label it that way in the UI.
//
// Below ground (air_mask.js). ERA5's extrapolations under the surface made
// eddies that aren't there: under the Antarctic plateau the 700 hPa row held
// −3 (Jan) to −8 m s⁻¹ day⁻¹ (Jul) of spurious convergence. The zonal means,
// the eddy covariances and the stratification count only cells above the
// surface (Boer 1982), and a level with less than a quarter of its latitude
// circle above ground is blank.
// Two details keep a circle that is partly underground from inventing
// vertical structure, because its air covers different longitudes at
// different levels:
//   - ∂[θ]/∂p is the mean over the air of each column's own ∂θ/∂p. The
//     difference of the air-part means compared different places: at 48°N
//     in January the 1000 hPa air is mostly the warm oceans', the 925 hPa
//     air takes in the cold continents, and the layer came out unstable.
//   - ∂F_p/∂p compares F_p at the two levels over the same columns, those
//     with air at the lower one.
// Near the ground F_p still grows where the stratification is weak (the
// wintertime marine surface layer), as any QG EP flux does there.
//
// Vertical derivatives, in ln p. θ ∝ p^−κ curves so much between the levels
// that a secant in p misses the stratification at the level: across the
// 10–50 hPa gap it was 3½× too small (F_p 3½× too large), and at 300 hPa it
// spanned 250–500 hPa. So ∂θ/∂p = (θ/p) ∂ln θ/∂ln p, from the three-point
// second-order derivative at the level, or the two-point secant at the top
// and where the level below is underground (both exact for an isothermal
// layer). ∂F_p/∂p = (1/p) ∂F_p/∂ln p, the centred secant in ln p: against
// the 37 levels it is within 0.05 m s⁻¹ day⁻¹ rms of the secant in p except
// at 300 hPa, where it is better; the three-point form lost as often as won.
// Checked against ERA5 on all 37 levels (NCAR GDEX d633001, 1991–2020): in
// January the rms error of the 250 hPa row falls from 1.6 to 0.4 m s⁻¹ day⁻¹
// and the convergence maximum moves from 250 hPa, 51°N (−7.7) to 300 hPa,
// 59°N (−4.4); on 37 levels it is −6.5 at 350 hPa, 57°N (−4.9 at 300 hPa,
// −5.5 at 400). The tree may also hold 400 and 600 hPa (diag_source.js
// sourceLevels: the 1991–2020 climatology does): then they are used too, the
// 250 hPa error is 0.2 and the maximum −4.8 at 400 hPa, 57°N.
//
// The 10 hPa row is still wrong: nothing above it, nothing between 10 and
// 50 hPa, and its ∂F_p/∂p across that gap doesn't see where the waves
// converge in the vortex (January rms error 1.6 m s⁻¹ day⁻¹, against 0.2–0.6
// at 50–500 hPa; 72°N: +2.2 where 37 levels have −2.3). Its ∇·F is left out
// and hatched as the top of the grid (`edge`). Its arrows stay: F_p is within
// 10–20 % of the 37-level value (it was 3½× too large).
//
// Output:
//   - values: ∇·F shading (m s⁻¹ day⁻¹) on the (nlev × nlat) panel grid,
//     nlev = levels.length (12, or 14 with 400 and 600 hPa)
//   - arrows: per-(lat, level) (F_φ, F_p) for vector rendering, in panel-
//     normalised units so arrow length is visually proportional in (φ, log p)
//     space (Edmon–Hoskins–McIntyre convention).
//   - ground: 1 where the level doesn't take part (air_mask.js; hatched)
//   - edge: 1 on the 10 hPa row (the grid's top; hatched)
//   - vmin/vmax: symmetric colour range from the panel's interior (below)

import { sourceMonth, sourceLevels } from './diag_source.js';
import { GRID } from './data.js';
import { airShare, airZonalMean, airZonalCov, ddy, groundCells, MIN_AIR_SHARE } from './air_mask.js';

/** Tiles the panel reads: u, v, T on every level it uses (diag_source.js
 *  sourceLevels: LEVELS, plus 400 and 600 hPa where the tree has them), and
 *  the surface pressure that says which are underground. */
export const EP_FLUX_INGREDIENTS = { pl: ['u', 'v', 't'], sl: ['sp'], extraLevels: true };

const A_EARTH = 6.371e6;
const OMEGA   = 7.2921e-5;
const KAPPA   = 0.2854;          // R_dry / cp
const D2R     = Math.PI / 180;
const DAY_SEC = 86400;
const DIV_UNIT = 1;              // m s⁻¹ day⁻¹  (typical |∇·F| ≈ 1–10)

// Subsample arrow positions so the panel doesn't get cluttered. One arrow
// every ARROW_LAT_STRIDE latitudes, and every ARROW_LEV_STRIDE levels.
// Values tuned for the standard panel; the renderer further trims arrows
// shorter than a dust threshold so the visible density stays sensible at
// any panel size.
const ARROW_LAT_STRIDE = 12;
const ARROW_LEV_STRIDE = 2;

// The auto colour range comes from the cells that are read quantitatively:
// RANGE_P_TOP–RANGE_P_BOT hPa (not the top two rows or the bottom two),
// within RANGE_LAT of the equator, and only where the level below has air all
// round the latitude circle, so ∂F_p/∂p isn't taken over the part of a circle
// beside the terrain. Next to the Antarctic plateau 700 hPa is the lowest
// level with air, and its F_p is several times that at 500 and 850 hPa: at
// 70–80°S in July the 500 hPa row reads −5 to −8 m s⁻¹ day⁻¹, where ERA5 on
// all 37 levels has −0.6 to +0.5, and it would set the April–October scale.
const RANGE_P_TOP = 100;
const RANGE_P_BOT = 850;
const RANGE_LAT   = 80;

/** Static stability ∂θ/∂p (K / Pa) at level m of `P` (hPa) in each column,
 *  = (θ/p) ∂ln θ/∂ln p: the three-point second-order derivative in ln p at
 *  the level; the two-point secant at the top and where the level below is
 *  underground in that column; NaN where level m is. LNTH = ln θ.
 *  Float32Array(nlat × nlon). */
function columnStability(TH, LNTH, SP, P, m) {
    const nlev = P.length;
    const out = new Float32Array(SP.length);
    const x = P.map(Math.log);
    let w0 = 0, w1 = 0, w2 = 0;
    if (m > 0 && m + 1 < nlev) {
        const h1 = x[m] - x[m - 1], h2 = x[m + 1] - x[m];
        w0 = -h2 / (h1 * (h1 + h2));
        w1 = (h2 - h1) / (h1 * h2);
        w2 = h1 / (h2 * (h1 + h2));
    }
    const pm = P[m] * 100;
    for (let idx = 0; idx < SP.length; idx++) {
        const ps = SP[idx];
        if (P[m] > ps) { out[idx] = NaN; continue; }
        const below = m + 1 < nlev && !(P[m + 1] > ps);
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

/** F_p = a cos φ · f · [v'θ'] / (∂θ/∂p) (Pa·m²·s⁻²) at level m, its zonal
 *  statistics over the columns with air at pressure pDom (≥ level m's); the
 *  stratification is the mean over those columns of their own ∂θ/∂p (`S`,
 *  columnStability). Float32Array(nlat); NaN where the level doesn't take
 *  part (air_mask.js) or the stratification is ~neutral. */
function verticalFlux(V, TH, S, SP, m, pDom) {
    const { nlat, nlon } = GRID;
    const Vm = V[m], THm = TH[m], Sm = S[m];
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        const cosPhi = Math.cos(lat * D2R);
        // One pass, NaN-safe: [v'θ'] = [vθ] - [v][θ] (float64 sums) and [∂θ/∂p].
        let n = 0, sv = 0, st = 0, svt = 0, sd = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const idx = row + j;
            if (pDom > SP[idx]) continue;
            const v = Vm[idx], th = THm[idx], d = Sm[idx];
            if (!Number.isFinite(v) || !Number.isFinite(th) || !Number.isFinite(d)) continue;
            sv += v; st += th; svt += v * th; sd += d;
            n++;
        }
        if (n < MIN_AIR_SHARE * nlon || cosPhi < 1e-3) { out[i] = NaN; continue; }
        const vT = svt / n - (sv / n) * (st / n);
        const dth = sd / n;
        // ∂θ/∂p is negative in the troposphere — ratio v'θ'/(∂θ/∂p) carries
        // the right sign. Tiny |∂θ/∂p| near the model top can blow up; cap.
        out[i] = (!Number.isFinite(vT) || !Number.isFinite(dth) || Math.abs(dth) < 1e-7)
            ? NaN
            : A_EARTH * cosPhi * 2 * OMEGA * Math.sin(lat * D2R) * vT / dth;
    }
    return out;
}

/** F_φ, F_p (SI) and ∇·F / (a cos φ) (m s⁻¹ day⁻¹) on the (k, i) panel grid
 *  of levels `P` (hPa) for one time slice (diag_source.js), with the cells
 *  that don't take part (air_mask.js groundCells) and the top row (`edge`),
 *  or null while any tile is missing. */
function epFluxFields(month, seasonal, source, P) {
    const { nlat } = GRID;
    const nlev = P.length;
    const SP = sourceMonth('sp', month, null, source, seasonal);   // hPa
    if (!SP) return null;

    const U = [], V = [], TH = [], LNTH = [];
    for (let k = 0; k < nlev; k++) {
        const tU = sourceMonth('u', month, P[k], source, seasonal);
        const tV = sourceMonth('v', month, P[k], source, seasonal);
        const tT = sourceMonth('t', month, P[k], source, seasonal);
        if (!tU || !tV || !tT) return null;
        const thetaFactor = Math.pow(1000 / P[k], KAPPA);
        // θ and ln θ tiles.
        const tTh = new Float32Array(tT.length);
        const tLn = new Float32Array(tT.length);
        for (let i = 0; i < tT.length; i++) {
            const v = tT[i];
            tTh[i] = Number.isFinite(v) ? v * thetaFactor : NaN;
            tLn[i] = Math.log(tTh[i]);
        }
        U.push(tU); V.push(tV); TH.push(tTh); LNTH.push(tLn);
    }
    const S = TH.map((_, m) => columnStability(TH, LNTH, SP, P, m));
    const ground = groundCells(SP, P);
    const edge = new Uint8Array(nlev * nlat);
    for (let i = 0; i < nlat; i++) edge[i] = ground[i] ? 0 : 1;
    // 1 where the level below has air all round the circle, at this latitude
    // and the ones either side (colour range, arrow scale). Next to the
    // Antarctic plateau the row above the lowest level with air carries
    // strong convergence on all 37 levels too, and the panel puts its edge a
    // degree or two too far north: July, 600 hPa, 69°S: −4.5 here, +0.3 on 37
    // levels, the one cell of that band whose own level below is all air
    // (it set the April, July and October scales).
    const fullBelow = new Uint8Array(nlev * nlat);
    for (let k = 0; k + 1 < nlev; k++) {
        const share = airShare(SP, P[k + 1]);
        for (let i = 0; i < nlat; i++) {
            fullBelow[k * nlat + i] = share[i] >= 1 && !(share[i - 1] < 1) && !(share[i + 1] < 1) ? 1 : 0;
        }
    }

    // F_φ, F_p on the (k, i) grid in SI, each level's zonal statistics over
    // its own air. F_φ cos φ for the meridional divergence.
    //   F_φ = -a cos φ · [u'v']            units: m³ s⁻²
    //   F_p =  a cos φ · f · [v'θ'] / (∂θ/∂p)   units: Pa·m²·s⁻²
    const Fphi = new Float32Array(nlev * nlat);
    const Fp   = new Float32Array(nlev * nlat);
    const FphiCos = new Float32Array(nlev * nlat);
    for (let k = 0; k < nlev; k++) {
        const p = P[k];
        const uZ = airZonalMean(U[k], SP, p);
        const vZ = airZonalMean(V[k], SP, p);
        const uv = airZonalCov(U[k], V[k], uZ, vZ, SP, p);
        const fp = verticalFlux(V, TH, S, SP, k, p);
        for (let i = 0; i < nlat; i++) {
            const idx = k * nlat + i;
            const cosPhi = Math.cos((90 - i) * D2R);
            Fphi[idx] = (!Number.isFinite(uv[i]) || cosPhi < 1e-3) ? NaN : -A_EARTH * cosPhi * uv[i];
            Fp[idx] = fp[i];
            FphiCos[idx] = Fphi[idx] * cosPhi;
        }
    }

    // ∇·F = (1/(a cos φ)) · ∂(F_φ cos φ)/∂φ + ∂F_p/∂p     units: m³ s⁻² / m = m² s⁻²
    // To get the eddy forcing ON [u]: divide by (a cos φ). Convert to m s⁻¹ day⁻¹.
    // ∂/∂φ = a ∂/∂y (northward), centred, one-sided next to a latitude with
    // no air at the level. ∂F_p/∂p = (1/p) ∂F_p/∂ln p, centred where the
    // level below has air on the circle, from F_p at the levels above and
    // below over the columns with air at the lower one; one-sided (this
    // level and the one above, over this level's air) at the bottom of the
    // air. Not at the top (`edge`).
    const divF = new Float32Array(nlev * nlat);
    divF.fill(NaN, 0, nlat);
    for (let k = 1; k < nlev; k++) {
        const kUp = k - 1;
        const kDn = Math.min(nlev - 1, k + 1);
        const pDn = P[kDn];
        const centred = kDn > k
            ? { up: verticalFlux(V, TH, S, SP, kUp, pDn), dn: Fp.subarray(kDn * nlat, (kDn + 1) * nlat) }
            : null;
        const oneSided = { up: verticalFlux(V, TH, S, SP, kUp, P[k]), dn: Fp.subarray(k * nlat, (k + 1) * nlat) };
        const pk = P[k] * 100;
        for (let i = 0; i < nlat; i++) {
            const idx = k * nlat + i;
            // The pole rows have no F_φ, and the rows next to them take no
            // one-sided difference across the pole either.
            if (i < 2 || i > nlat - 3 || ground[idx]) { divF[idx] = NaN; continue; }
            const cosPhi = Math.cos((90 - i) * D2R);
            const aCos = A_EARTH * cosPhi;
            const pair = centred && !ground[kDn * nlat + i] ? centred : oneSided;
            const dFphi_dy = ddy(FphiCos, k, i);
            const dFp_dp = (pair.dn[i] - pair.up[i])
                / (Math.log(P[pair === centred ? kDn : k] / P[kUp]) * pk);
            if (!Number.isFinite(dFphi_dy) || !Number.isFinite(dFp_dp)) {
                divF[idx] = NaN; continue;
            }
            // ∇·F in m² s⁻²; eddy momentum forcing on [u] = (∇·F)/(a cos φ) m/s²
            // Convert to m/s/day for readability.
            const div_si = dFphi_dy / cosPhi + dFp_dp;
            divF[idx] = (div_si / aCos) * DAY_SEC / DIV_UNIT;
        }
    }
    return { Fphi, Fp, divF, ground, edge, fullBelow };
}

/**
 * Stationary-eddy EP flux for `source` (null = active climatology).
 * `anomaly: true` with a year / composite source returns the departure from
 * the active climatology instead: F(source) − F(climatology), arrows and
 * divergence alike (∇·F is linear in F).
 */
export function computeEPFlux(month, { seasonal = false, source = null, anomaly = false } = {}) {
    const { nlat } = GRID;
    const isAnomaly = anomaly && source != null;
    // The selection and its reference on one set of levels.
    const P = sourceLevels(isAnomaly ? [source, null] : [source], EP_FLUX_INGREDIENTS.pl);
    const nlev = P.length;
    const F = epFluxFields(month, seasonal, source, P);
    if (!F) return null;
    const { Fphi, Fp, divF, ground, edge, fullBelow } = F;
    if (isAnomaly) {
        const ref = epFluxFields(month, seasonal, null, P);
        if (!ref) return null;
        for (let idx = 0; idx < Fphi.length; idx++) {
            Fphi[idx] -= ref.Fphi[idx];
            Fp[idx]   -= ref.Fp[idx];
            divF[idx] -= ref.divF[idx];
            ground[idx] |= ref.ground[idx];
            edge[idx] |= ref.edge[idx];
            fullBelow[idx] &= ref.fullBelow[idx];
        }
    }

    // The cells read quantitatively (RANGE_*).
    const interior = (k, i) => P[k] >= RANGE_P_TOP && P[k] <= RANGE_P_BOT
        && Math.abs(90 - i) <= RANGE_LAT && fullBelow[k * nlat + i] === 1;

    // Symmetric range so the divergent colormap centres on zero, from the
    // interior cells and clamped to [1, 20]. Taken over the whole panel it
    // was set every month by a row to read qualitatively or a polar cap
    // (January +14.8 at 10 hPa, 72°N, against −7.7 at 250 hPa, 51°N); those
    // cells now saturate, and the hover still reads them.
    let absMax = 0;
    for (let k = 0; k < nlev; k++) {
        for (let i = 0; i < nlat; i++) {
            if (!interior(k, i)) continue;
            const v = Math.abs(divF[k * nlat + i]);
            if (v > absMax) absMax = v;
        }
    }
    if (absMax > 20) absMax = 20;
    if (absMax < 1) absMax = 1;
    const vmin = -absMax, vmax = absMax;

    // Build the arrow sample grid. Visual normalisation (Edmon–Hoskins–McIntyre):
    // we plot vectors in (φ, log p) space, so the components must be scaled
    // into the same display units. We use:
    //   dx ∝ F_φ        (will be scaled to panel-φ in the renderer)
    //   dy ∝ F_p · A    where A gives F_φ and F_p at their largest the same
    //                   visual length, both taken over the interior cells.
    // Over the whole panel the largest F_p was in the near-neutral surface
    // layer (January: 1000 hPa, 41°N, 2.4× the interior's), and every arrow
    // came out about twice as flat. The renderer draws the longest interior
    // arrow (maxLen) at its standard length; longer ones, near the ground
    // and at the top, saturate there.
    const arrowLats = [];
    const arrowPress = [];
    const arrowDx   = [];
    const arrowDy   = [];
    let absFphiMax = 0, absFpMax = 0;
    for (let i = 0; i < nlat; i++) {
        for (let k = 0; k < nlev; k++) {
            if (!interior(k, i)) continue;
            const fp = Fphi[k * nlat + i];
            const vp = Fp  [k * nlat + i];
            if (Number.isFinite(fp) && Math.abs(fp) > absFphiMax) absFphiMax = Math.abs(fp);
            if (Number.isFinite(vp) && Math.abs(vp) > absFpMax)   absFpMax   = Math.abs(vp);
        }
    }
    if (absFphiMax === 0) absFphiMax = 1;
    if (absFpMax   === 0) absFpMax   = 1;
    const vGain = absFphiMax / absFpMax;
    let maxLen = 0;
    for (let i = ARROW_LAT_STRIDE; i < nlat; i += ARROW_LAT_STRIDE) {
        const lat = 90 - i;
        if (Math.abs(lat) > 80) continue;
        for (let k = 0; k < nlev; k++) {
            const fp = Fphi[k * nlat + i];
            const vp = Fp  [k * nlat + i];
            if (!Number.isFinite(fp) || !Number.isFinite(vp)) continue;
            arrowLats.push(lat);
            arrowPress.push(P[k]);
            arrowDx.push(fp);
            arrowDy.push(vp * vGain);
            if (interior(k, i)) maxLen = Math.max(maxLen, Math.hypot(fp, vp * vGain));
        }
    }

    return {
        kind: 'zonal',
        type: 'pl',
        values: divF,
        vmin, vmax,
        levels: P.slice(),
        ground,
        edge,
        name: isAnomaly ? 'EP flux anomaly (stationary eddy)' : 'EP flux (stationary eddy)',
        units: 'm s⁻¹ day⁻¹',
        isSymmetric: true,
        isDiagnostic: true,
        arrows: {
            lats:  Float32Array.from(arrowLats),
            pressures: Float32Array.from(arrowPress),
            dx:    Float32Array.from(arrowDx),
            dy:    Float32Array.from(arrowDy),
            maxLen,
        },
    };
}
