// GC-ATLAS — derived diagnostics for the cross-section panel.
//
// First entry: mass streamfunction ψ(φ, p).
//
//   ψ(φ, p) = (2π a cos φ / g) · ∫₀ᵖ [v](p') dp'
//
// where [v] is the zonal mean meridional wind at pressure p' and the
// integral runs from the top of the atmosphere down to p. Sign convention:
// ψ > 0 is counter-clockwise in (φ, p) — NH Hadley cell shows up as a
// positive closed contour (rising at the equator, sinking at the subtropics,
// upper-level poleward flow, lower-level equatorward return).
//
// Output values in 10⁹ kg s⁻¹ for display.
//
// Below ground (air_mask.js), [v] carries only the air: ψ integrates [βv], v
// summed over the cells above the surface ÷ the whole circle (Boer 1982), so
// ψ is the mass flux through the part of the circle that is open. ERA5's
// below-ground winds had drawn a cell of their own around Antarctica, ψ =
// +45 (Jan) to +73 ×10⁹ kg s⁻¹ (Jul) at 72°S, 1000 hPa — as strong as the
// Ferrel cells, and July's maximum of ψ. Levels with less than a quarter of
// the circle above ground are blank.
//
// M, [u_g] and N² average over the air the same way. [u_g] and N² are
// derivatives, and a partly underground circle has its air at different
// longitudes on neighbouring latitudes and levels: differencing the air-part
// [z] or [T] compares different places (at 1000 hPa, 50°N in January the air
// is mostly the warm oceans', at 925 hPa it takes in the cold continents, and
// N² from the air-part [T] came out −0.6 × 10⁻⁴ s⁻²). So each column takes its
// own ∂z/∂y or ∂θ/∂p, and the panel shows their mean over the air — as the EP
// flux's stratification does (ep_flux.js).

import { sourceMonth, sourceLevels } from './diag_source.js';
import { LEVELS, GRID } from './data.js';
import { airZonalMean, groundCells, columnStability, thetaTiles } from './air_mask.js';

/** Tiles the N² panel reads: T on LEVELS, plus 400 and 600 hPa where the
 *  tree has them (diag_source.js sourceLevels), and the surface pressure. */
export const N2_INGREDIENTS = { pl: ['t'], sl: ['sp'], extraLevels: true };

const A_EARTH = 6.371e6;         // m
const G       = 9.80665;         // m s⁻²
const OMEGA   = 7.2921e-5;       // rad s⁻¹
const R_DRY   = 287.04;          // J kg⁻¹ K⁻¹ — dry-air gas constant
const KAPPA   = 0.2854;          // R_dry / cp
const D2R     = Math.PI / 180;
const PSI_UNIT = 1e9;            // 10⁹ kg/s
const M_UNIT   = 1e9;            // 10⁹ m²/s
const N2_UNIT  = 1e-4;           // 10⁻⁴ s⁻²  (tropospheric N² ≈ 1, stratosphere ≈ 4)

/**
 * Compute the monthly-mean mass streamfunction ψ(lat, p). Requires v tiles
 * at all pressure levels for the given month; returns null if any are
 * missing (caller should prefetch and retry on the next fire). Every
 * diagnostic here reads its tiles from `source` (see diag_source.js:
 * null = active climatology, { year }, or { years } composite).
 * `anomaly: true` with a year / composite source returns ψ(source) −
 * ψ(active climatology).
 */
export function computeMassStreamfunction(month, { seasonal = false, source = null, anomaly = false } = {}) {
    const res = psiValues(month, seasonal, source);
    if (!res) return null;
    const { psi, ground } = res;
    const isAnomaly = anomaly && source != null;
    if (isAnomaly) {
        const ref = psiValues(month, seasonal, null);
        if (!ref) return null;
        for (let i = 0; i < psi.length; i++) {
            psi[i] -= ref.psi[i];
            ground[i] |= ref.ground[i];
        }
    }

    // Symmetric range so the divergent colormap centres on zero.
    let absMax = 0;
    for (const v of psi) {
        if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
    }
    if (absMax === 0) absMax = 1;

    return {
        kind: 'zonal',
        type: 'pl',
        values: psi,
        vmin: -absMax,
        vmax:  absMax,
        levels: LEVELS.slice(),
        ground,
        name: isAnomaly ? 'Mass streamfunction anomaly ψ′' : 'Mass streamfunction ψ',
        units: '10⁹ kg s⁻¹',
        isSymmetric: true,
        isDiagnostic: true,
    };
}

/** ψ(k, lat) in 10⁹ kg s⁻¹ for one time slice, with the cells that are
 *  blank as ground (air_mask.js groundCells), or null while tiles load. */
function psiValues(month, seasonal, source) {
    const { nlat, nlon } = GRID;
    const nlev = LEVELS.length;
    const SP = sourceMonth('sp', month, null, source, seasonal);   // hPa
    if (!SP) return null;

    // [βv] at each (k, lat): v summed over the cells above the surface, ÷ the
    // circle (its cells with a value) — NaN-aware.
    const vzm = new Float32Array(nlev * nlat);
    for (let k = 0; k < nlev; k++) {
        const tile = sourceMonth('v', month, LEVELS[k], source, seasonal);
        if (!tile) return null;
        const p = LEVELS[k];
        for (let i = 0; i < nlat; i++) {
            let s = 0, n = 0;
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                const v = tile[row + j];
                if (!Number.isFinite(v)) continue;
                n += 1;
                if (!(p > SP[row + j])) s += v;
            }
            vzm[k * nlat + i] = n > 0 ? s / n : NaN;
        }
    }
    const ground = groundCells(SP);

    // Integrate from TOA (k=0, small p) downward with the trapezoidal rule.
    // dp is in Pa so ψ comes out in kg/s. Ground cells keep integrating
    // (their sliver of air counts) but show blank.
    const psi = new Float32Array(nlev * nlat);
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        const cosPhi = Math.cos(lat * D2R);
        const scale = (2 * Math.PI * A_EARTH * cosPhi) / G;
        let accum = 0;
        psi[i] = 0;   // top level
        for (let k = 1; k < nlev; k++) {
            const v0 = vzm[(k - 1) * nlat + i];
            const v1 = vzm[k * nlat + i];
            if (!Number.isFinite(v0) || !Number.isFinite(v1)) {
                psi[k * nlat + i] = NaN;
                continue;
            }
            const dp = (LEVELS[k] - LEVELS[k - 1]) * 100;   // hPa → Pa
            accum += 0.5 * (v0 + v1) * dp;
            psi[k * nlat + i] = ground[k * nlat + i] ? NaN : scale * accum / PSI_UNIT;
        }
    }
    return { psi, ground };
}

/**
 * Absolute zonal-mean angular momentum M(φ, p) = (Ω a cos φ + u) · a cos φ,
 * where u is the zonal-mean zonal wind. Output in 10⁹ m² s⁻¹.
 *
 * Pedagogically this is where the subtropical jet "comes from" —
 * parcels rising at the equator in the Hadley cell carry M ≈ Ω a², so
 * as they move poleward aloft (cos φ falls), u must rise to conserve M,
 * producing the upper-tropospheric zonal jet near the Hadley cell's
 * poleward edge.
 *
 * [u] is the mean over the air (air_mask.js); cells with less than a
 * quarter of the circle above ground are blank (hatched).
 */
export function computeAngularMomentum(month, { seasonal = false, source = null } = {}) {
    const { nlat } = GRID;
    const nlev = LEVELS.length;
    const SP = sourceMonth('sp', month, null, source, seasonal);   // hPa
    if (!SP) return null;

    // Zonal-mean u over the air at each (k, lat).
    const uzm = new Float32Array(nlev * nlat);
    for (let k = 0; k < nlev; k++) {
        const tile = sourceMonth('u', month, LEVELS[k], source, seasonal);
        if (!tile) return null;
        uzm.set(airZonalMean(tile, SP, LEVELS[k]), k * nlat);
    }

    const M = new Float32Array(nlev * nlat);
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        const cosPhi = Math.cos(lat * D2R);
        const aCos   = A_EARTH * cosPhi;
        const solid  = OMEGA * A_EARTH * cosPhi;   // m/s
        for (let k = 0; k < nlev; k++) {
            const u = uzm[k * nlat + i];
            if (!Number.isFinite(u)) { M[k * nlat + i] = NaN; continue; }
            const m = (solid + u) * aCos / M_UNIT;
            M[k * nlat + i] = m;
            if (m < vmin) vmin = m;
            if (m > vmax) vmax = m;
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }

    return {
        kind: 'zonal',
        type: 'pl',
        values: M,
        vmin, vmax,
        levels: LEVELS.slice(),
        ground: groundCells(SP),
        name: 'Angular momentum M',
        units: '10⁹ m² s⁻¹',
        isSymmetric: false,
        isDiagnostic: true,
    };
}

/**
 * Zonal-mean geostrophic zonal wind on the (lat, p) panel.
 *
 *   [u_g](φ, p) = -(g/f) · ∂[z]/∂y
 *
 * where [z] is the zonal-mean geopotential height (m) and f = 2Ω·sinφ.
 *
 * Pedagogically pairs with the field section of `u`: students see where the
 * actual zonal wind matches u_g (free-troposphere mid-latitudes — beautiful
 * geostrophy) and where it doesn't (boundary layer, jet entrance/exit
 * regions, deep tropics where f → 0). The 200 hPa subtropical-jet maximum
 * shows up cleanly in u_g as a closed contour package.
 *
 * Deep tropics (|φ| < 5°) are masked: f → 0 makes u_g singular and the
 * geostrophic approximation fundamentally invalid there.
 *
 * Below ground (air_mask.js): ∂z/∂y is taken in each column with air at the
 * level — centred, one-sided where the point north or south of it is
 * underground — and averaged over those columns, so [u_g] is the mean over
 * the air of the local geostrophic wind, like the field section's [u]. The
 * difference of the air-part [z] would compare different longitudes at
 * neighbouring latitudes: it matched the air-part [u] worse than the
 * all-circle [z] did (rms 1.1 vs 0.5 m/s at 500–850 hPa, 25–45°N in July).
 */
export function computeGeostrophicWind(month, { seasonal = false, source = null } = {}) {
    const { nlat, nlon } = GRID;
    const nlev = LEVELS.length;
    const SP = sourceMonth('sp', month, null, source, seasonal);   // hPa
    if (!SP) return null;

    // z tiles are already in meters after era5.js's m²/s² → m unit
    // conversion at load time, so we work directly with height.
    const Z = [];
    for (let k = 0; k < nlev; k++) {
        const tile = sourceMonth('z', month, LEVELS[k], source, seasonal);
        if (!tile) return null;
        Z.push(tile);
    }
    const ground = groundCells(SP);

    // Coriolis f(lat). No clamping needed because we mask the tropical band
    // explicitly below.
    const fCor = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        fCor[i] = 2 * OMEGA * Math.sin(lat * D2R);
    }

    // u_g(k, lat) = -(g/f) · [∂z/∂y] over the air, y = a·φ.
    const ug = new Float32Array(nlev * nlat);
    let absMax = 0;
    for (let k = 0; k < nlev; k++) {
        const p = LEVELS[k];
        const z = Z[k];
        for (let i = 0; i < nlat; i++) {
            const lat = 90 - i;
            // Mask the geostrophic-invalid tropical band, and the levels that
            // are mostly underground.
            if (Math.abs(lat) < 5 || ground[k * nlat + i]) {
                ug[k * nlat + i] = NaN;
                continue;
            }
            let s = 0, n = 0;
            for (let j = 0; j < nlon; j++) {
                if (p > SP[i * nlon + j]) continue;
                let iN = Math.max(0, i - 1);
                let iS = Math.min(nlat - 1, i + 1);
                if (p > SP[iN * nlon + j]) iN = i;
                if (p > SP[iS * nlon + j]) iS = i;
                if (iN === iS) continue;
                const zN = z[iN * nlon + j], zS = z[iS * nlon + j];
                if (!Number.isFinite(zN) || !Number.isFinite(zS)) continue;
                s += (zN - zS) / (A_EARTH * (iS - iN) * D2R);   // m/m, positive northward
                n += 1;
            }
            if (n === 0) { ug[k * nlat + i] = NaN; continue; }
            const u_g = -G * (s / n) / fCor[i];               // m/s
            ug[k * nlat + i] = u_g;
            if (Math.abs(u_g) > absMax) absMax = Math.abs(u_g);
        }
    }

    // Symmetric range so the divergent colormap centres on zero. Cap at the
    // 95th percentile to keep occasional polar spikes from squashing the jet
    // signal.
    const finite = [];
    for (const v of ug) if (Number.isFinite(v)) finite.push(Math.abs(v));
    finite.sort((a, b) => a - b);
    const cap = finite.length > 0 ? finite[Math.floor(0.95 * (finite.length - 1))] : absMax;
    let vmax = Math.min(absMax, cap);
    if (vmax < 5)   vmax = 5;
    if (vmax > 100) vmax = 100;

    return {
        kind: 'zonal',
        type: 'pl',
        values: ug,
        vmin: -vmax,
        vmax:  vmax,
        levels: LEVELS.slice(),
        ground,
        name: 'Geostrophic zonal wind [u_g]',
        units: 'm s⁻¹',
        isSymmetric: true,
        isDiagnostic: true,
    };
}

/**
 * Brunt–Väisälä frequency squared on the (lat, p) zonal-mean grid.
 *
 *   N² = (g / θ) · ∂θ/∂z = -(g² p / (R T θ)) · ∂θ/∂p
 *
 * where θ = T·(1000/p)^κ. Output in 10⁻⁴ s⁻² (tropospheric N² ≈ 1,
 * stratospheric ≈ 4 in these units).
 *
 * ∂θ/∂p = (θ/p) ∂ln θ/∂ln p in each column (air_mask.js columnStability, as
 * the EP flux's stratification): the three-point derivative in ln p at the
 * level, two-point at the top and above the ground. Against ERA5 on all 37
 * levels (1991–2020) the centred differences in p it replaces were 3½× too
 * small at 10 hPa (one-sided across 10–50 hPa: January rms error 3.5 ×
 * 10⁻⁴ s⁻², now 0.3), 1.6× too large at 50 hPa (2.6 → 0.4) and spanned
 * 250–500 hPa at 300 hPa (0.7 → 0.2). Where the tree also holds 400 and
 * 600 hPa (diag_source.js sourceLevels) the panel uses them: 300 hPa 0.1.
 *
 * Below ground (air_mask.js): ∂θ/∂p is the mean over the air of each
 * column's own ∂θ/∂p (one-sided where the level below is underground in
 * that column), and T, θ in the prefactor are the air-part zonal means.
 * The difference of the air-part [θ] between levels would compare different
 * longitudes: at 1000 hPa, 50°N in January it gave N² = −0.6, the column
 * mean gives 1.5 (all-circle [T], extrapolations included: 1.7).
 *
 * Pedagogically this exposes static stability: the stratosphere lights up as
 * a strongly stable layer, the tropical free troposphere is weakly stable,
 * and the boundary layer / inversions in mid-latitudes show finer structure.
 */
export function computeBruntVaisala(month, { seasonal = false, source = null } = {}) {
    const { nlat, nlon } = GRID;
    const P = sourceLevels([source], N2_INGREDIENTS.pl);
    const nlev = P.length;
    const SP = sourceMonth('sp', month, null, source, seasonal);   // hPa
    if (!SP) return null;

    const T = [];
    for (let k = 0; k < nlev; k++) {
        const tile = sourceMonth('t', month, P[k], source, seasonal);
        if (!tile) return null;
        T.push(tile);
    }
    const { TH, LNTH } = thetaTiles(T, P, KAPPA);
    const ground = groundCells(SP, P);

    // N² = -(g² p / (R T θ)) · ∂θ/∂p, ∂θ/∂p in K/Pa. P is ascending in p
    // (top of atmosphere at index 0, surface at last).
    const N2 = new Float32Array(nlev * nlat);
    let vmin = Infinity, vmax = -Infinity;
    for (let k = 0; k < nlev; k++) {
        const p = P[k] * 100;     // hPa → Pa
        const Tzm = airZonalMean(T[k], SP, P[k]);
        const thetaFactor = Math.pow(1000 / P[k], KAPPA);
        const S = columnStability(TH, LNTH, SP, P, k);   // NaN under the ground
        for (let i = 0; i < nlat; i++) {
            const Tm = Tzm[i];
            const Th = Tm * thetaFactor;
            if (ground[k * nlat + i] || !Number.isFinite(Tm)) {
                N2[k * nlat + i] = NaN;
                continue;
            }
            // [∂θ/∂p] over the columns with air at this level.
            let s = 0, n = 0;
            for (let j = 0; j < nlon; j++) {
                const d = S[i * nlon + j];
                if (Number.isFinite(d)) { s += d; n += 1; }
            }
            if (n === 0) { N2[k * nlat + i] = NaN; continue; }
            const dthdp = s / n;
            const n2 = -(G * G * p / (R_DRY * Tm * Th)) * dthdp;
            const out = n2 / N2_UNIT;
            N2[k * nlat + i] = out;
            if (out < vmin) vmin = out;
            if (out > vmax) vmax = out;
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 4; }
    // Clamp the colorbar a little — exotic values near the model top can blow it
    // out and squash the troposphere; cap at 12 (× 10⁻⁴ s⁻²).
    if (vmax > 12) vmax = 12;
    if (vmin < -2) vmin = -2;

    return {
        kind: 'zonal',
        type: 'pl',
        values: N2,
        vmin, vmax,
        levels: P.slice(),
        ground,
        name: 'Brunt–Väisälä N²',
        units: '10⁻⁴ s⁻²',
        isSymmetric: false,
        isDiagnostic: true,
    };
}
