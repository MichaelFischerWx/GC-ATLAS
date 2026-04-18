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

const A_EARTH = 6.371e6;   // m
const G       = 9.80665;   // m s⁻²
const D2R     = Math.PI / 180;
const PSI_UNIT = 1e9;      // 10⁹ kg/s

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
