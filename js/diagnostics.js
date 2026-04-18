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

import { cachedMonth } from './era5.js';
import { LEVELS, GRID } from './data.js';

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
 * missing (caller should prefetch and retry on the next fire).
 */
export function computeMassStreamfunction(month) {
    const { nlat, nlon } = GRID;
    const nlev = LEVELS.length;

    // Zonal-mean v at each (k, lat) — NaN-aware.
    const vzm = new Float32Array(nlev * nlat);
    for (let k = 0; k < nlev; k++) {
        const tile = cachedMonth('v', month, LEVELS[k]);
        if (!tile) return null;
        for (let i = 0; i < nlat; i++) {
            let s = 0, n = 0;
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                const v = tile[row + j];
                if (Number.isFinite(v)) { s += v; n += 1; }
            }
            vzm[k * nlat + i] = n > 0 ? s / n : NaN;
        }
    }

    // Integrate from TOA (k=0, small p) downward with the trapezoidal rule.
    // dp is in Pa so ψ comes out in kg/s.
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
            psi[k * nlat + i] = scale * accum / PSI_UNIT;
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
        name: 'Mass streamfunction ψ',
        units: '10⁹ kg s⁻¹',
        isSymmetric: true,
        isDiagnostic: true,
    };
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
 */
export function computeAngularMomentum(month) {
    const { nlat, nlon } = GRID;
    const nlev = LEVELS.length;

    // Zonal-mean u at each (k, lat).
    const uzm = new Float32Array(nlev * nlat);
    for (let k = 0; k < nlev; k++) {
        const tile = cachedMonth('u', month, LEVELS[k]);
        if (!tile) return null;
        for (let i = 0; i < nlat; i++) {
            let s = 0, n = 0;
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                const v = tile[row + j];
                if (Number.isFinite(v)) { s += v; n += 1; }
            }
            uzm[k * nlat + i] = n > 0 ? s / n : NaN;
        }
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
        name: 'Angular momentum M',
        units: '10⁹ m² s⁻¹',
        isSymmetric: false,
        isDiagnostic: true,
    };
}

/**
 * Brunt–Väisälä frequency squared on the (lat, p) zonal-mean grid.
 *
 *   N² = (g / θ) · ∂θ/∂z = -(g² p / (R T θ)) · ∂θ/∂p
 *
 * where θ = T·(1000/p)^κ. Computed from zonal-mean T at each (lat, p), with
 * centred differences in p (one-sided at the edges). Output in 10⁻⁴ s⁻²
 * (tropospheric N² ≈ 1, stratospheric ≈ 4 in these units).
 *
 * Pedagogically this exposes static stability: the stratosphere lights up as
 * a strongly stable layer, the tropical free troposphere is weakly stable,
 * and the boundary layer / inversions in mid-latitudes show finer structure.
 */
export function computeBruntVaisala(month) {
    const { nlat, nlon } = GRID;
    const nlev = LEVELS.length;

    // Zonal-mean T and θ at each (k, lat).
    const Tzm = new Float32Array(nlev * nlat);
    const Thzm = new Float32Array(nlev * nlat);
    for (let k = 0; k < nlev; k++) {
        const tile = cachedMonth('t', month, LEVELS[k]);
        if (!tile) return null;
        const thetaFactor = Math.pow(1000 / LEVELS[k], KAPPA);
        for (let i = 0; i < nlat; i++) {
            let s = 0, n = 0;
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                const v = tile[row + j];
                if (Number.isFinite(v)) { s += v; n += 1; }
            }
            const T = n > 0 ? s / n : NaN;
            Tzm[k * nlat + i] = T;
            Thzm[k * nlat + i] = T * thetaFactor;
        }
    }

    // ∂θ/∂p with centred differences in pressure (Pa). LEVELS is ascending in p
    // (top of atmosphere at index 0, surface at last). N² = -(g² p / (R T θ)) · dθ/dp.
    const N2 = new Float32Array(nlev * nlat);
    let vmin = Infinity, vmax = -Infinity;
    for (let k = 0; k < nlev; k++) {
        const p = LEVELS[k] * 100;     // hPa → Pa
        for (let i = 0; i < nlat; i++) {
            const T  = Tzm[k * nlat + i];
            const Th = Thzm[k * nlat + i];
            if (!Number.isFinite(T) || !Number.isFinite(Th)) {
                N2[k * nlat + i] = NaN;
                continue;
            }
            let dthdp;
            if (k === 0) {
                const dp = (LEVELS[1] - LEVELS[0]) * 100;
                dthdp = (Thzm[1 * nlat + i] - Thzm[0 * nlat + i]) / dp;
            } else if (k === nlev - 1) {
                const dp = (LEVELS[nlev - 1] - LEVELS[nlev - 2]) * 100;
                dthdp = (Thzm[(nlev - 1) * nlat + i] - Thzm[(nlev - 2) * nlat + i]) / dp;
            } else {
                const dp = (LEVELS[k + 1] - LEVELS[k - 1]) * 100;
                dthdp = (Thzm[(k + 1) * nlat + i] - Thzm[(k - 1) * nlat + i]) / dp;
            }
            const n2 = -(G * G * p / (R_DRY * T * Th)) * dthdp;
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
        levels: LEVELS.slice(),
        name: 'Brunt–Väisälä N²',
        units: '10⁻⁴ s⁻²',
        isSymmetric: false,
        isDiagnostic: true,
    };
}
