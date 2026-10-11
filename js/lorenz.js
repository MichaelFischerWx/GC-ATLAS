// GC-ATLAS — Lorenz energy cycle (stationary-eddy form).
//
// From the monthly-mean fields u, v, w (= ω in Pa/s), t we form four
// reservoirs and four conversions on the global mass-weighted volume.
// Definitions follow Peixoto & Oort (1974, 1992 textbook), with a reference
// temperature profile T_ref(p) of one of two kinds (refType below): Lorenz's
// (1955) minimum-PE state, the atmosphere's mass re-stratified by θ, or the
// global area-mean of T on each pressure level.
//
//   γ(p)     = κ T_ref/p - ∂T_ref/∂p             (K/Pa, the static-stability factor)
//   stability:  σ(p) = (R / γ(p))·(1/p) ; we work directly with γ.
//
//   T̂(φ, p) = [T] - T_ref       (zonal-mean departure from the reference)
//   T*(λ, φ, p) = T - [T]         (stationary-eddy departure from the zonal mean)
//   u*, v*, ω*  defined likewise.
//
// Reservoirs (J/m², mass-weighted vertical integral over the column):
//   P_M = (R/2g) · ∫ T̂² / (γ · p) · dp · ⟨area⟩
//   P_E = (R/2g) · ∫ ⟨T*²⟩ / (γ · p) · dp
//   K_M = (1/2g) · ∫ ([u]² + [v]²) · dp
//   K_E = (1/2g) · ∫ ⟨u*² + v*²⟩ · dp
//
// (⟨·⟩ denotes the area-weighted horizontal mean over the globe.)
//
// The leading factor is R/(2g), NOT cp/(2g) — this matches the canonical
// Holton-Hakim / Vallis / Tian-Zhang derivation and reproduces Peixoto-Oort
// 1992's P_M ≈ 4 MJ/m². An earlier draft used cp/(2g) and overshot by ~3.5×.
//
// Conversions (W/m²):
//   C(P_M → P_E) = -(R/g) · ∫ ⟨v*T*⟩ / (γ p) · ∂[T]/∂y · dp
//                  -(R/g) · ∫ ⟨ω*T*⟩ · p^-κ ∂(p^κ T̂ / (γ p))/∂p · dp
//   C(P_E → K_E) = -(R/g) · ∫ ⟨ω*T*⟩ / p · dp           (eddy buoyancy flux)
//   C(K_E → K_M) =  (1/g) · ∫ ⟨u*v*⟩ cosφ · ∂([u]/cosφ)/∂y · dp        (eddy momentum)
//                  +(1/g) · ∫ ⟨u*ω*⟩ · ∂[u]/∂p · dp
//   C(P_M → K_M) = -(R/g) · ∫ ⟨[ω]″[T]″⟩ / p · dp        (mean meridional circulation)
//
// The vertical term of C(P_M → P_E) is Peixoto & Oort's (1974; 1992 ch. 14)
// -c_p ∫ p^-κ [ω*T*] ∂(γ_PO p^κ T̂)/∂p dm with c_p γ_PO = R/(γ p): the term
// P_M's own budget yields, and the one Li et al. (2007) evaluate. It acts on
// T̂, not on [T]: the eddy heat flux working against the reference lapse rate
// ∂T_ref/∂p is the eddy buoyancy flux, already in C(P_E → K_E). An earlier
// version used ∂[T]/∂p, which added ~(∂T_ref/∂p / γ) × C(P_E → K_E) and
// doubled the climatological C(P_M → P_E). The vertical leg of C(K_E → K_M)
// has no reference state, so ∂[u]/∂p is right there.
//
// C(P_M → K_M) is also Peixoto & Oort's: ( )″ is the departure from the
// level's area mean, so the reference state drops out, as it must for
// -∫[ω][α] dm when the mean ω on a level vanishes. It used to read ⟨[ω] T̂⟩,
// which is the same thing only if ⟨[ω]⟩ = 0. The data don't quite have
// that, and below ground they're far off (next paragraph). The sorted panel
// then carried a spurious (⟨T⟩ - T_ref)·⟨[ω]⟩ term (Jan: -0.8 W/m²).
//
// Below ground. ERA5 fills pressure levels under the surface with
// extrapolated values (Jan: 2 % of the 700 hPa surface, 9 % at 925, 33 % at
// 1000). Their ω is not a circulation: +0.02 to +0.10 Pa/s on average at
// 700–1000 hPa, against < 0.001 over the air there. With the cold
// extrapolated T it alone gave C(P_M → K_M) ≈ +0.9 (Jan) to +1.3 W/m² (Jul).
// Under Antarctica they also made a third of the July C(P_M → P_E). So,
// following Boer (1982), a cell only counts where p ≤ p_s (the monthly-mean
// surface pressure). Zonal means are over the above-ground part of each
// latitude circle. Every area mean weights a latitude by that part's share
// of the circle, normalised by the whole sphere, so ∫ dp/g stays a mass
// integral over the air that's there.
//
// Levels. LEVELS, plus 400 and 600 hPa where the tree has them
// (diag_source.js sourceLevels: the 1991–2020 climatology). Checked against
// the same cycle on all 37 ERA5 levels (10–1000 hPa, NCAR GDEX d633001):
// the extra levels help, differences in ln p (for γ and the vertical terms)
// don't. January, 12 → 14 levels: C(P_M → K_M) −0.020 → −0.037 W/m² (37
// levels: −0.049; the 500–700 hPa layer held most of the miss), P_M 3.69 →
// 3.66 MJ/m² (3.62); July C(P_M → P_E) 0.22 → 0.20 (0.18). The slab reference
// puts T_ref at 300 hPa 2.8 K too cold on 12 levels (its slab runs 275–400
// hPa), 1.0 K on 14.
//
// Stationary-eddy only — transient terms (covariances of high-frequency
// departures from the monthly mean) require daily data and are out of scope.
// Returns SI numbers; caller renders them in a schematic.

import { sourceMonth, sourceLevels } from './diag_source.js';
import { GRID } from './data.js';

const R_DRY = 287.04;
const CP    = 1004;
const KAPPA = R_DRY / CP;
const G     = 9.80665;
const A_E   = 6.371e6;
const D2R   = Math.PI / 180;

/** Tiles the panel reads for the globe's time slice: u, v, ω, T on every
 *  level (LEVELS, plus 400 and 600 hPa where the tree has them:
 *  diag_source.js sourceLevels), plus the surface pressure that says which
 *  of them are underground. */
export const LORENZ_INGREDIENTS = { pl: ['u', 'v', 'w', 't'], sl: ['sp'], extraLevels: true };

/** Layer edges (hPa) of levels P: level k stands for [edges[k], edges[k + 1]],
 *  half-way to its neighbours, from 10 hPa at the top to 1000 hPa — the
 *  layers the trapezoidal ∫dp gives each level. */
function layerEdges(P) {
    const N = P.length;
    const edges = new Float64Array(N + 1);
    edges[0] = P[0];
    for (let k = 1; k < N; k++) edges[k] = (P[k - 1] + P[k]) / 2;
    edges[N] = P[N - 1];
    return edges;
}

/**
 * Lorenz (1955) reference state by adiabatic mass-resorting.
 *
 * The minimum-PE configuration places highest-θ parcels at the top and
 * lowest-θ at the bottom, preserving mass. Only air is sorted: a column
 * gives its levels down to the deepest one above the surface, each standing
 * for its layer (layerEdges), the deepest one's layer reaching down to the
 * surface (below 1000 hPa where p_s > 1000 hPa; the transport panel's
 * convention). Levels under the surface are ERA5 extrapolations, not air.
 * The sorted column runs from 10 hPa down to the global-mean surface
 * pressure (~986 hPa).
 *
 * Procedure:
 *   1. Collect (θ, w) for every above-ground (k, i, j), w ∝ cosφ_i × its
 *      layer's thickness (drop constant dλ, dφ, a², 1/g — we only need ratios).
 *   2. Sort descending by θ.
 *   3. Level k stands for the slab [edges[k], edges[k + 1]] of the sorted
 *      column (cut at its bottom). θ_r(P[k]) is the mass-weighted mean θ
 *      of that slab.
 *   4. Convert θ_r → T_r via T_r = θ_r · (P[k]/1000)^κ.
 *
 * Step 3 used to take θ of the single parcel at cumulative mass
 * (P[k] / 1000 hPa) × total. At 1000 hPa that's the coldest parcel on
 * the globe: Jan 233.5 K (the Yakutian cold pool), Jul 239 K (an
 * extrapolation 300 hPa under the Antarctic plateau). That gave γp/T = 1.3
 * at 925 hPa and 2.7 at 1000 hPa, so the lowest layer contributed almost
 * nothing to P_M, P_E or C(P_M → P_E). The slab-mean reference is still
 * stable at the bottom (Jan γp/T 0.6 at 925 hPa, 0.8 at 1000), because the
 * coldest ~2 % of the mass (winter-continent and polar boundary-layer air)
 * pools there in the minimum-PE state. That's the reference state, not the
 * grid: the sorted column itself, differenced over 900–950 hPa, gives 0.58.
 *
 * `tiles` holds the T tile at each level P[k] and `sp` the surface pressure
 * (hPa), both already loaded by the caller.
 */
function lorenzReferenceState(tiles, sp, P) {
    const { nlat, nlon } = GRID;
    const N = P.length;
    const edges = layerEdges(P);

    // Build flat (θ, w) arrays. cosφ < 1e-3 (poles) skipped — they carry no
    // mass anyway. Rough size: 12 levels × 181 lats × 360 lons ≈ 780k entries
    // less the ~6 % underground.
    const cosArr = new Float32Array(nlat);
    let area = 0;                         // Σ cosφ over the columns sorted
    for (let i = 0; i < nlat; i++) {
        const c = Math.max(0, Math.cos((90 - i) * D2R));
        cosArr[i] = c;
        if (c >= 1e-3) area += c * nlon;
    }

    // Layer thickness (hPa) of level k's air in the column with surface
    // pressure ps: 0 underground; the deepest level above the surface reaches
    // down to it. A missing p_s keeps the full 10–1000 hPa column.
    const thickness = (k, ps) => {
        if (P[k] > ps) return 0;
        const deeper = k + 1 < N && !(P[k + 1] > ps);
        const bottom = deeper || !Number.isFinite(ps) ? edges[k + 1] : ps;
        return bottom - edges[k];
    };

    // Pre-count valid entries so we can use typed arrays (faster sort).
    let nValid = 0;
    for (let k = 0; k < N; k++) {
        const tile = tiles[k];
        for (let i = 0; i < nlat; i++) {
            if (cosArr[i] < 1e-3) continue;
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                if (Number.isFinite(tile[row + j]) && thickness(k, sp[row + j]) > 0) nValid++;
            }
        }
    }
    if (nValid === 0) return null;

    const thetas  = new Float64Array(nValid);
    const weights = new Float64Array(nValid);
    let idx = 0;
    let totalW = 0;
    for (let k = 0; k < N; k++) {
        const tile = tiles[k];
        const thetaFactor = Math.pow(1000 / P[k], KAPPA);
        for (let i = 0; i < nlat; i++) {
            const c = cosArr[i];
            if (c < 1e-3) continue;
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                const T = tile[row + j];
                if (!Number.isFinite(T)) continue;
                const dp = thickness(k, sp[row + j]);
                if (!(dp > 0)) continue;
                thetas[idx]  = T * thetaFactor;
                weights[idx] = c * dp;
                idx++;
                totalW += c * dp;
            }
        }
    }

    // Sort by θ descending. Build an index array so we sort in O(N log N)
    // without copying the value/weight pairs around.
    const order = new Uint32Array(nValid);
    for (let i = 0; i < nValid; i++) order[i] = i;
    order.sort((a, b) => thetas[b] - thetas[a]);

    // The sorted column holds totalW / area hPa of air below 10 hPa, so its
    // bottom is the global-mean surface pressure. Walk down it slab by slab,
    // averaging θ over each level's slab (parcels straddling a slab edge
    // count with the part inside).
    const pBottom = edges[0] + totalW / area;
    const Tref = new Float32Array(N);
    let cumW = 0;        // mass of the parcels above order[rank]
    let rank = 0;
    for (let k = 0; k < N; k++) {
        const wTop = (Math.min(edges[k], pBottom) - edges[0]) * area;
        const wBot = (Math.min(edges[k + 1], pBottom) - edges[0]) * area;
        while (rank < nValid && cumW + weights[order[rank]] <= wTop) {
            cumW += weights[order[rank]];
            rank++;
        }
        let sTheta = 0, sW = 0;
        for (let r = rank, c = cumW; r < nValid && c < wBot; r++) {
            const w = weights[order[r]];
            const inside = Math.min(c + w, wBot) - Math.max(c, wTop);
            if (inside > 0) { sTheta += thetas[order[r]] * inside; sW += inside; }
            c += w;
        }
        // An empty slab (a level below the column's bottom) can't happen for
        // a global mean p_s of ~986 hPa; fall back to the bottom parcel.
        const theta_r = sW > 0 ? sTheta / sW : thetas[order[nValid - 1]];
        Tref[k] = theta_r * Math.pow(P[k] / 1000, KAPPA);
    }
    return Tref;
}

/** Area-weighted (cos φ) horizontal mean of a (nlat × nlon) field. NaN-safe. */
function areaMean(values, nlat, nlon) {
    let s = 0, w = 0;
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        const cosPhi = Math.max(0, Math.cos(lat * D2R));
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const v = values[row + j];
            if (!Number.isFinite(v)) continue;
            s += v * cosPhi;
            w += cosPhi;
        }
    }
    return w > 0 ? s / w : NaN;
}

/** Trapezoidal integral of f(p) over the levels P (hPa) in Pa, NaN-safe
 *  (skip NaN sub-intervals). */
function trapInP(arr, P) {
    const n = arr.length;
    let s = 0;
    for (let k = 0; k < n - 1; k++) {
        const a = arr[k], b = arr[k + 1];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const dp = (P[k + 1] - P[k]) * 100;
        s += 0.5 * (a + b) * dp;
    }
    return s;
}

/** Centred-difference (or one-sided) ∂[T]/∂y in degrees K per metre at each lat,
 *  given a zonal-mean column (one value per latitude). One-sided at the poles
 *  and next to latitudes with no air on the level (NaN). Returns Float32Array. */
function dByDy(zm, nlat) {
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let iN = Math.max(0, i - 1);
        let iS = Math.min(nlat - 1, i + 1);
        if (!Number.isFinite(zm[iN])) iN = i;
        if (!Number.isFinite(zm[iS])) iS = i;
        const dyN = (90 - iN);                 // lat to north (deg)
        const dyS = (90 - iS);                 // lat to south
        const dy_m = (dyN - dyS) * D2R * A_E;  // metres
        const num = zm[iN] - zm[iS];           // north - south
        out[i] = (Number.isFinite(num) && dy_m !== 0) ? (num / dy_m) : NaN;
    }
    return out;
}

/** Centred-difference ∂X/∂p (Pa⁻¹) over the levels P (hPa). arr indexed
 *  [k * nlat + i]; one-sided at the top and bottom, and above a level with
 *  no air at this latitude (NaN). */
function dByDp_levels(arr, nlat, k, i, P) {
    const N = P.length;
    let kUp = Math.max(0, k - 1);
    let kDn = Math.min(N - 1, k + 1);
    if (!Number.isFinite(arr[kUp * nlat + i])) kUp = k;
    if (!Number.isFinite(arr[kDn * nlat + i])) kDn = k;
    if (kUp === kDn) return NaN;
    const dp = (P[kDn] - P[kUp]) * 100;
    return (arr[kDn * nlat + i] - arr[kUp * nlat + i]) / dp;
}

/**
 * Compute the Lorenz energy cycle for a given month.
 *
 * @param {number} month            1..12
 * @param {string} refType          'lorenz' (adiabatic-resorted reference state,
 *                                   Lorenz 1955 original) or 'simple'
 *                                   (area-mean of T at each pressure level — the
 *                                   common approximation used in most reanalysis
 *                                   diagnostics; it counts the unavailable part of
 *                                   the meridional T contrast, so P_M comes out
 *                                   ~10-20 % larger).
 * @param {object} [opts]           { seasonal, source }: the 3-month centred
 *                                   mean flag and the time slice (diag_source.js;
 *                                   null = active climatology).
 */
export function computeLorenzCycle(month, refType = 'lorenz', { seasonal = false, source = null } = {}) {
    const { nlat, nlon } = GRID;
    // LEVELS, plus 400 and 600 hPa where the tree has them (diag_source.js).
    const P = sourceLevels([source], LORENZ_INGREDIENTS.pl);
    const N = P.length;

    // Pull every needed tile up front. If anything is missing, the panel
    // can't render yet — return null and the caller will retry as tiles
    // arrive.
    const U = [], V = [], W = [], T = [];
    for (let k = 0; k < N; k++) {
        const u = sourceMonth('u', month, P[k], source, seasonal);
        const v = sourceMonth('v', month, P[k], source, seasonal);
        const w = sourceMonth('w', month, P[k], source, seasonal);
        const t = sourceMonth('t', month, P[k], source, seasonal);
        if (!u || !v || !w || !t) return null;
        U.push(u); V.push(v); W.push(w); T.push(t);
    }
    const SP = sourceMonth('sp', month, null, source, seasonal);   // hPa
    if (!SP) return null;

    // Per-level reference state and zonal means.
    // Choice of reference state matters substantially — see refType arg.
    let Tref;
    if (refType === 'lorenz') {
        Tref = lorenzReferenceState(T, SP, P);
        if (!Tref) return null;
    } else {
        // The mean over the whole isobaric surface, ERA5's below-ground values
        // included. Over the air alone, the 1000 hPa mean would cover only the
        // warm low-lying two-thirds of the globe and sit superadiabatically
        // under 925 hPa (Jan 289.5 vs 283.1 K).
        Tref = new Float32Array(N);
        for (let k = 0; k < N; k++) Tref[k] = areaMean(T[k], nlat, nlon);
    }
    const dTrefDp = new Float32Array(N);
    const gamma = new Float32Array(N);             // K/Pa, static-stability factor
    for (let k = 0; k < N; k++) {
        let dT;
        if (k === 0) {
            dT = (Tref[1] - Tref[0]) / ((P[1] - P[0]) * 100);
        } else if (k === N - 1) {
            dT = (Tref[N - 1] - Tref[N - 2]) / ((P[N - 1] - P[N - 2]) * 100);
        } else {
            dT = (Tref[k + 1] - Tref[k - 1]) / ((P[k + 1] - P[k - 1]) * 100);
        }
        dTrefDp[k] = dT;
        const p = P[k] * 100;
        // γ = κ T_ref/p - ∂T_ref/∂p   (positive in the troposphere)
        gamma[k] = KAPPA * Tref[k] / p - dT;
    }

    const cosArr = new Float32Array(nlat);
    let cosSum = 0;
    for (let i = 0; i < nlat; i++) {
        const c = Math.max(0, Math.cos((90 - i) * D2R));
        cosArr[i] = c;
        cosSum += c;
    }

    // Zonal means over the above-ground part of each latitude circle, and
    // that part's share of the circle (Boer's [β]; 0 where the level is
    // underground all the way round, e.g. 1000 hPa over Antarctica). A
    // missing p_s counts as air.
    const Tzm = new Array(N), Uzm = new Array(N), Vzm = new Array(N), Wzm = new Array(N);
    const airFrac = new Array(N);
    for (let k = 0; k < N; k++) {
        const pk = P[k];
        const tz = new Float32Array(nlat), uz = new Float32Array(nlat);
        const vz = new Float32Array(nlat), wz = new Float32Array(nlat);
        const fr = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            let st = 0, su = 0, sv = 0, sw = 0, n = 0;
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                const idx = row + j;
                if (pk > SP[idx]) continue;
                const Tv = T[k][idx], Uv = U[k][idx], Vv = V[k][idx], Wv = W[k][idx];
                if (!Number.isFinite(Tv) || !Number.isFinite(Uv) ||
                    !Number.isFinite(Vv) || !Number.isFinite(Wv)) continue;
                st += Tv; su += Uv; sv += Vv; sw += Wv;
                n += 1;
            }
            tz[i] = n > 0 ? st / n : NaN;
            uz[i] = n > 0 ? su / n : NaN;
            vz[i] = n > 0 ? sv / n : NaN;
            wz[i] = n > 0 ? sw / n : NaN;
            fr[i] = n / nlon;
        }
        Tzm[k] = tz; Uzm[k] = uz; Vzm[k] = vz; Wzm[k] = wz; airFrac[k] = fr;
    }

    // Per-(lat) and per-(level) area / zonal aggregates we need.
    // Stationary eddy products: ⟨T*²⟩, ⟨u*²+v*²⟩, ⟨v*T*⟩, ⟨ω*T*⟩, ⟨u*v*⟩, ⟨u*ω*⟩
    // Built level-by-level. T̂ = [T] - T_ref also lives here.
    const PE_int = new Float32Array(N);    // (R/2g)·⟨T*²⟩/(γp) per level (vertical integrand, J/m²/Pa weighted by dp later)
    const KE_int = new Float32Array(N);    // (1/2g)·⟨u*²+v*²⟩ per level
    const PM_int = new Float32Array(N);    // (R/2g)·area-mean(T̂²/(γp))
    const KM_int = new Float32Array(N);    // (1/2g)·area-mean([u]²+[v]²)

    // Conversion integrands (per level, in p):
    const cPMPE_y = new Float32Array(N);   // -(R/g)·area-mean(⟨v*T*⟩/(γp) · ∂[T]/∂y)  (per level dp)
    const cPMPE_p = new Float32Array(N);   // -(R/g)·area-mean(⟨ω*T*⟩ · p^-κ ∂(p^κ T̂/(γp))/∂p)
    const cPEKE   = new Float32Array(N);   // -(R/g)·area-mean(⟨ω*T*⟩/p)
    const cKMKE_y = new Float32Array(N);   // (1/g)·area-mean(⟨u*v*⟩ · cos·∂([u]/cos)/∂y)
    const cKMKE_p = new Float32Array(N);   // (1/g)·area-mean(⟨u*ω*⟩ · ∂[u]/∂p)
    const cPMKM   = new Float32Array(N);   // -(R/g)·area-mean([ω]″[T]″/p)

    // p^κ T̂/(γp) at every (level, lat), indexed [k * nlat + i] for
    // dByDp_levels: what the vertical term of C(P_M → P_E) differentiates
    // (Peixoto-Oort's γ_PO p^κ T̂, up to the constant c_p/R). [u] likewise,
    // for ∂[u]/∂p. NaN where the level has no air at that latitude.
    const ThatScaled = new Float64Array(N * nlat);
    const UzmFlat = new Float64Array(N * nlat);
    for (let k = 0; k < N; k++) {
        const p = P[k] * 100;
        const s = Math.pow(p, KAPPA) / Math.max(gamma[k] * p, 1e-9);
        for (let i = 0; i < nlat; i++) {
            ThatScaled[k * nlat + i] = (Tzm[k][i] - Tref[k]) * s;
            UzmFlat[k * nlat + i] = Uzm[k][i];
        }
    }

    // For the meridional gradient ∂[T]/∂y we need [T] at each level and lat;
    // for ∂[u]/∂p and ∂(p^κ T̂/(γp))/∂p we need vertical neighbours.
    for (let k = 0; k < N; k++) {
        const p = P[k] * 100;
        const gp = gamma[k] * p;
        const pMinusKappa = Math.pow(p, -KAPPA);
        const fr = airFrac[k];

        // d[T]/dy at this level
        const dTdy = dByDy(Tzm[k], nlat);
        // u/cosφ for ∂(u/cos)/∂y
        const uOverCos = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            const c = cosArr[i];
            uOverCos[i] = c > 1e-3 ? Uzm[k][i] / c : NaN;
        }
        const dUcosDy = dByDy(uOverCos, nlat);

        // Mean ω over the level's air: [ω]″ = [ω] - this, so ⟨[ω]″⟩ = 0.
        let sOmega = 0, wOmega = 0;
        for (let i = 0; i < nlat; i++) {
            const c = cosArr[i];
            if (c < 1e-3 || !(fr[i] > 0)) continue;
            sOmega += c * fr[i] * Wzm[k][i];
            wOmega += c * fr[i];
        }
        const omegaMean = wOmega > 0 ? sOmega / wOmega : 0;

        // Area-weighted accumulators. A latitude counts by cosφ × the share of
        // its circle above ground; ÷ Σcosφ over the whole sphere below.
        let acc_Tstar2 = 0, acc_uv2 = 0, acc_That2 = 0, acc_Kmean = 0;
        let acc_term_y = 0, acc_term_p = 0;
        let acc_PEKE   = 0;
        let acc_KMKE_y = 0, acc_KMKE_p = 0;
        let acc_PMKM   = 0;

        // (∂[u]/∂p and ∂(p^κ T̂/(γp))/∂p computed per-lat below.)

        for (let i = 0; i < nlat; i++) {
            const c = cosArr[i];
            if (c < 1e-3 || !(fr[i] > 0)) continue;
            // Stationary-eddy moments at (k, i): sum over the circle's air,
            // ÷ nlon = the circle's mean × its above-ground share.
            let s_T2 = 0, s_u2v2 = 0, s_vT = 0, s_wT = 0, s_uv = 0, s_uw = 0;
            const Tk = T[k], Uk = U[k], Vk = V[k], Wk = W[k];
            const Tbar = Tzm[k][i], Ubar = Uzm[k][i], Vbar = Vzm[k][i], Wbar = Wzm[k][i];
            for (let j = 0; j < nlon; j++) {
                const idx = i * nlon + j;
                if (P[k] > SP[idx]) continue;
                const Tv = Tk[idx], Uv = Uk[idx], Vv = Vk[idx], Wv = Wk[idx];
                if (!Number.isFinite(Tv) || !Number.isFinite(Uv) ||
                    !Number.isFinite(Vv) || !Number.isFinite(Wv)) continue;
                const Tp = Tv - Tbar, Up = Uv - Ubar, Vp = Vv - Vbar, Wp = Wv - Wbar;
                s_T2   += Tp * Tp;
                s_u2v2 += Up * Up + Vp * Vp;
                s_vT   += Vp * Tp;
                s_wT   += Wp * Tp;
                s_uv   += Up * Vp;
                s_uw   += Up * Wp;
            }
            const T2_zon  = s_T2   / nlon;
            const uv2_zon = s_u2v2 / nlon;
            const vT_zon  = s_vT   / nlon;
            const wT_zon  = s_wT   / nlon;
            const uv_zon  = s_uv   / nlon;
            const uw_zon  = s_uw   / nlon;

            // T̂ = [T] - T_ref, weighted like the eddy moments.
            const That = Tbar - Tref[k];
            const cf = c * fr[i];

            // ∂[u]/∂p and p^-κ ∂(p^κ T̂/(γp))/∂p, centred where both
            // neighbours have air.
            const dUbar_dp = dByDp_levels(UzmFlat, nlat, k, i, P);
            const dThat_dp = pMinusKappa * dByDp_levels(ThatScaled, nlat, k, i, P);

            // Reservoirs at this (k, i).
            acc_Tstar2 += T2_zon * c;
            acc_uv2    += uv2_zon * c;
            acc_That2  += (That * That) * cf;
            acc_Kmean  += (Ubar * Ubar + Vbar * Vbar) * cf;

            // Conversion integrands at this (k, i).
            // C(P_M → P_E)  -- meridional eddy heat flux acting on the gradient.
            if (Number.isFinite(dTdy[i]))
                acc_term_y += vT_zon * dTdy[i] * c;
            // Plus the vertical eddy heat flux acting on the vertical structure
            // of T̂ (P&O form; small next to the meridional term).
            if (Number.isFinite(dThat_dp))
                acc_term_p += wT_zon * dThat_dp * c;

            // C(P_E → K_E) — eddy buoyancy flux  -(R/g)·⟨ω*T*⟩/p
            acc_PEKE += wT_zon * c;

            // C(K_M → K_E) — eddy momentum on the ∂([u]/cosφ)/∂y, plus vertical leg.
            if (Number.isFinite(dUcosDy[i]))
                acc_KMKE_y += uv_zon * c * c * dUcosDy[i];   // include cosφ once explicitly
            if (Number.isFinite(dUbar_dp))
                acc_KMKE_p += uw_zon * dUbar_dp * c;

            // C(P_M → K_M) — mean meridional circulation: -(R/g)·[ω]″T̂/p
            // (= [ω]″[T]″: ⟨[ω]″⟩ = 0 takes T_ref out).
            acc_PMKM += (Wbar - omegaMean) * That * cf;
        }

        const cs = cosSum > 0 ? cosSum : 1;
        const gpSafe = Math.max(gp, 1e-9);

        // Reservoir per-level (units J/m²/Pa, integrate in p later).
        // R/(2g) is the canonical Vallis/Holton-Hakim leading factor.
        PE_int[k] = (R_DRY / (2 * G)) * (acc_Tstar2 / cs) / gpSafe;
        KE_int[k] = (1 / (2 * G)) * (acc_uv2 / cs);
        PM_int[k] = (R_DRY / (2 * G)) * (acc_That2 / cs) / gpSafe;
        KM_int[k] = (1 / (2 * G)) * (acc_Kmean / cs);

        // Conversion per-level integrands (units W/m²/Pa, integrate in p later).
        cPMPE_y[k] = -(R_DRY / G) * (acc_term_y / cs) / gpSafe;
        cPMPE_p[k] = -(R_DRY / G) * (acc_term_p / cs);   // 1/(γp) is inside ThatScaled
        cPEKE[k]   = -(R_DRY / G) * (acc_PEKE / cs) / p;
        cKMKE_y[k] = (1 / G) * (acc_KMKE_y / cs);
        cKMKE_p[k] = (1 / G) * (acc_KMKE_p / cs);
        cPMKM[k]   = -(R_DRY / G) * (acc_PMKM / cs) / p;
    }

    const PM = trapInP(PM_int, P);
    const PE = trapInP(PE_int, P);
    const KM = trapInP(KM_int, P);
    const KE = trapInP(KE_int, P);

    const C_PM_PE = trapInP(cPMPE_y, P) + trapInP(cPMPE_p, P);
    const C_PE_KE = trapInP(cPEKE, P);
    // K_E → K_M: positive when stationary eddies surrender momentum to the
    // zonal-mean flow (eddies decaying into the jet). The integrand
    // ⟨u*v*⟩ cosφ ∂([u]/cosφ)/∂y already carries the right sign.
    const C_KE_KM = trapInP(cKMKE_y, P) + trapInP(cKMKE_p, P);
    const C_PM_KM = trapInP(cPMKM, P);

    return {
        refType,
        levels: P,                                            // hPa
        Tref,                                                 // K, at each levels[k]
        reservoirs: { PM, PE, KM, KE },                       // J/m²
        conversions: { C_PM_PE, C_PE_KE, C_KE_KM, C_PM_KM },  // W/m²
    };
}
