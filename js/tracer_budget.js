// GC-ATLAS — the zonal-mean budget of a tracer s per unit mass (q, or the
// moist static energy h), shared by the Q and H budgets.
//
//   ∂[s]/∂t = −(1/(a cosφ)) ∂([v][s] cosφ)/∂y − ∂([ω][s])/∂p      mean circulation
//             −(1/(a cosφ)) ∂([v*s*] cosφ)/∂y − ∂([ω*s*])/∂p      stationary eddies
//             + sources
//
// Mass correction. Monthly-mean v and ω on pressure levels don't satisfy
// continuity (ψ doesn't close at the ground: 35 × 10⁹ kg/s in January, −49
// in July at 1000 hPa on the equator), and in flux form each mean term
// carries [s] times the divergence of the mean mass flux. With h ≈ 3×10⁵
// J/kg that is hundreds of W/m² in the column: poleward of 80°S the July
// ∫dp/g total was −640 to +1340 W/m², single terms ±2900. So the mean
// circulation is made to conserve mass: [v] plus the barotropic (vertically
// uniform) wind that brings the net mass flux across the latitude circle to
// zero (Trenberth 1991, 1997, here with a zero target, as a closed ψ), and
// [ω] from continuity, integrated down from the top, as for ψ. Away from
// the ground it is ERA5's circulation: at 500 hPa in January the two ω
// differ by the imbalance only (2.8 vs 2.3 × 10⁻² Pa/s at 15°N, −3.2 vs −2.9
// at 10°S). The two mean terms now add up to (a discretisation of) the
// advective form −[v]·∇[s] − [ω]∂[s]/∂p, so their sum is meaningful level by
// level; each alone still holds [s] times its own half of the (balanced)
// mass divergence.
//
// Finite volume on the air layers (air_mask.js, Boer 1982). Level k stands
// for the layer between the midpoints to its neighbours, down to p_s in each
// column (transport.js's quadrature); [·] is the mass-weighted mean over the
// layer's air, * the departure from it. Mass and tracer cross the layer's
// open sides only: nothing passes through the top or into the ground. A
// level a latitude has no air at (the neighbours' fluxes straddle terrain)
// hands its divergence to the deepest layer that has air, so every layer's
// mass budget closes. Hence the column integral (∫dp/g) of each meridional
// term is exactly the convergence of its column transport — ∮∫[v][s]dp/g
// (mass-corrected) and ∮∫[v*s*]dp/g, transport.js's MMC and stationary
// eddies — and the vertical terms integrate to zero. Per unit mass = the
// layer's term ÷ its air. Each layer's transport is smoothed across latitude
// before it is differenced (3 passes of 1-4-6-4-1, as the budgets always
// were), which keeps all of that: the column view is the convergence of the
// smoothed transports. (The vertical smoothing the budgets had is gone: it
// moved the flux-form terms between layers of different mass.)
//
// The transport panel lets its MMC carry the net vapour flux instead
// (Trenberth 1997). A net mass flux carries energy that depends on the zero
// of the energy scale (Ē ≈ 3 × 10⁵ J/kg with T in kelvin), matched in the
// column only by the enthalpy of the water crossing the surface, which LH +
// SH + radiation leave out: the transport panel's target moves ≈ Ē (E − P)
// between its MMC line and this one, up to ~15 W/m² in the deep tropics,
// ≤ 6 W/m² poleward of 30°, nothing near the poles. With a zero target the
// totals compare with those surface and radiative fluxes directly.

import { LEVELS, GRID } from './data.js';
import { groundCells } from './air_mask.js';

const A_EARTH = 6.371e6;
const G       = 9.80665;
const D2R     = Math.PI / 180;
const SMOOTH_PASSES = 3;

const { nlat: NLAT, nlon: NLON } = GRID;
const NLEV = LEVELS.length;
const HALF = LEVELS.slice(0, -1).map((p, k) => 0.5 * (p + LEVELS[k + 1]));   // layer edges, hPa
const COS = new Float64Array(NLAT);
for (let i = 0; i < NLAT; i++) COS[i] = (i === 0 || i === NLAT - 1) ? 0 : Math.cos((90 - i) * D2R);

/** In-place 1-4-6-4-1 smoother across latitude of each level's row of a
 *  [k * NLAT + i] array, zero beyond the air and at the poles (linear, so
 *  the column sum of smoothed rows is the smoothed column sum). */
function smoothRows(arr, nrows) {
    const tmp = new Float64Array(NLAT);
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
        for (let k = 0; k < nrows; k++) {
            const off = k * NLAT;
            for (let i = 1; i < NLAT - 1; i++) {
                let s = 6 * arr[off + i];
                if (i - 1 > 0)        s += 4 * arr[off + i - 1];
                if (i - 2 > 0)        s += arr[off + i - 2];
                if (i + 1 < NLAT - 1) s += 4 * arr[off + i + 1];
                if (i + 2 < NLAT - 1) s += arr[off + i + 2];
                tmp[i] = s / 16;
            }
            tmp[0] = 0; tmp[NLAT - 1] = 0;
            for (let i = 0; i < NLAT; i++) arr[off + i] = tmp[i];
        }
    }
}

/**
 * Budget terms of tracer S (per-level tiles, per unit mass) carried by V
 * (m/s) and W (ω, Pa/s), below ground masked with the surface pressure tile
 * `sp` (hPa).
 *
 * Returns
 *   meanY, meanP, eddyY, eddyP   per unit mass (S units s⁻¹), [k * nlat + i];
 *                                NaN where a level has less than a quarter
 *                                of its circle above ground, and at the poles
 *   total, source                their sum, and −sum (the implied source)
 *   col                          the same six as ∫dp/g over the air, per
 *                                latitude (S units × kg m⁻² s⁻¹: W/m² for
 *                                h); NaN at the poles
 *   colMass                      the air column, kg m⁻² (= [p_s]/g)
 *   transport                    { mmc, se }: northward column transports,
 *                                S units × kg s⁻¹, smoothed as differenced
 *   massRemoved                  net northward mass flux of the uncorrected
 *                                mean meridional wind, kg s⁻¹
 *   ground                       groundCells(sp)
 */
export function tracerBudget(V, W, S, sp) {
    const NK = NLEV * NLAT;
    // Mass-weighted sums over each layer's air (weights in hPa).
    const sW = new Float64Array(NK), sV = new Float64Array(NK), sS = new Float64Array(NK);
    const sVS = new Float64Array(NK), sO = new Float64Array(NK), sOS = new Float64Array(NK);
    const nAir = new Float64Array(NK);
    for (let i = 0; i < NLAT; i++) {
        const row = i * NLON;
        for (let j = 0; j < NLON; j++) {
            const ps = sp[row + j];
            if (!(ps > LEVELS[0])) continue;
            let kb = 0;
            while (kb + 1 < NLEV && LEVELS[kb + 1] <= ps) kb++;
            for (let k = 0; k <= kb; k++) {
                const x = k * NLAT + i;
                nAir[x] += 1;
                const v = V[k][row + j], w = W[k][row + j], s = S[k][row + j];
                if (!Number.isFinite(v) || !Number.isFinite(w) || !Number.isFinite(s)) continue;
                const top = k === 0 ? 0 : HALF[k - 1];
                const dp = (k === kb ? ps : HALF[k]) - top;
                sW[x] += dp; sV[x] += dp * v; sS[x] += dp * s;
                sVS[x] += dp * v * s; sO[x] += dp * w; sOS[x] += dp * w * s;
            }
        }
    }

    // Per level and latitude: the air (hPa), [s], and cos φ × the northward
    // fluxes per unit length — mean mass (hPa m/s) with the barotropic
    // correction, mean tracer and eddy tracer (× S units) — and the eddy
    // vertical flux [ω*s*] through the open part of the interface under each
    // level (hPa/s × S units).
    const mu = new Float64Array(NK), sBar = new Float64Array(NK).fill(NaN);
    const tM = new Float64Array(NK), tF = new Float64Array(NK), tE = new Float64Array(NK);
    const eP = new Float64Array(NK);
    const kMax = new Int32Array(NLAT).fill(-1);
    const massRemoved = new Float64Array(NLAT);
    for (let i = 0; i < NLAT; i++) {
        let colW = 0, colV = 0;
        for (let k = 0; k < NLEV; k++) {
            const x = k * NLAT + i;
            if (!(sW[x] > 0)) continue;
            kMax[i] = k;
            colW += sW[x]; colV += sV[x];
            mu[x] = sW[x] / NLON;
            sBar[x] = sS[x] / sW[x];
        }
        massRemoved[i] = colV / NLON * 2 * Math.PI * A_EARTH * COS[i] * 100 / G;
        const vc = colW > 0 ? -colV / colW : 0;        // m/s
        let covAbove = NaN;
        for (let k = 0; k <= kMax[i]; k++) {
            const x = k * NLAT + i;
            if (!(sW[x] > 0)) continue;
            const m = (sV[x] + vc * sW[x]) / NLON;
            tM[x] = COS[i] * m;
            tF[x] = COS[i] * m * sBar[x];
            tE[x] = COS[i] * (sVS[x] - sV[x] * sBar[x]) / NLON;
            const cov = sOS[x] / sW[x] - (sO[x] / sW[x]) * sBar[x];   // Pa/s × S
            // Interface above level k: open where level k has air.
            if (k > 0) eP[(k - 1) * NLAT + i] = (nAir[x] / NLON) * 0.5 * (covAbove + cov) / 100;
            covAbove = cov;
        }
    }
    smoothRows(tM, NLEV);
    smoothRows(tF, NLEV);
    smoothRows(tE, NLEV);
    smoothRows(eP, NLEV);

    const meanY = new Float32Array(NK).fill(NaN), meanP = new Float32Array(NK).fill(NaN);
    const eddyY = new Float32Array(NK).fill(NaN), eddyP = new Float32Array(NK).fill(NaN);
    const col = {
        meanY: new Float32Array(NLAT).fill(NaN), meanP: new Float32Array(NLAT).fill(NaN),
        eddyY: new Float32Array(NLAT).fill(NaN), eddyP: new Float32Array(NLAT).fill(NaN),
    };
    const colMass = new Float32Array(NLAT);
    const transport = { mmc: new Float64Array(NLAT), se: new Float64Array(NLAT) };
    const ground = groundCells(sp);
    const dM = new Float64Array(NLEV), dF = new Float64Array(NLEV), dE = new Float64Array(NLEV);
    const toKgS = 2 * Math.PI * A_EARTH * 100 / G;
    for (let i = 0; i < NLAT; i++) {
        let fs = 0, es = 0;
        for (let k = 0; k < NLEV; k++) { fs += tF[k * NLAT + i]; es += tE[k * NLAT + i]; }
        transport.mmc[i] = fs * toKgS;
        transport.se[i]  = es * toKgS;
        let air = 0;
        for (let k = 0; k <= kMax[i]; k++) air += mu[k * NLAT + i];
        colMass[i] = air * 100 / G;
    }
    for (let i = 1; i < NLAT - 1; i++) {
        const kb = kMax[i];
        if (kb < 0) continue;
        // −∇· of each level's fluxes (hPa/s × S); a level with no air here
        // hands its divergence to the deepest layer that has air.
        const scale = 2 * D2R * A_EARTH * COS[i];
        dM.fill(0); dF.fill(0); dE.fill(0);
        for (let k = 0; k < NLEV; k++) {
            const a = (k * NLAT) + i, kk = Math.min(k, kb);
            dM[kk] += (tM[a - 1] - tM[a + 1]) / scale;
            dF[kk] += (tF[a - 1] - tF[a + 1]) / scale;
            dE[kk] += (tE[a - 1] - tE[a + 1]) / scale;
        }
        // Downward mass flux through the interface under each level, from
        // continuity (zero at the top; at the ground it is zero to rounding,
        // and nothing crosses there).
        let omega = 0, fluxAbove = 0, eAbove = 0;
        let cY = 0, cP = 0, cEY = 0, cEP = 0;
        for (let k = 0; k <= kb; k++) {
            const x = k * NLAT + i;
            omega -= dM[k];
            let flux = 0, eFlux = 0;
            if (k < kb) {
                flux = omega * 0.5 * (sBar[x] + sBar[x + NLAT]);
                eFlux = eP[x];
            }
            const tY = -dF[k], tP = -(flux - fluxAbove);
            const tEY = -dE[k], tEP = -(eFlux - eAbove);
            fluxAbove = flux; eAbove = eFlux;
            cY += tY; cP += tP; cEY += tEY; cEP += tEP;
            if (ground[x] || !(mu[x] > 0)) continue;
            meanY[x] = tY / mu[x];
            meanP[x] = tP / mu[x];
            eddyY[x] = tEY / mu[x];
            eddyP[x] = tEP / mu[x];
        }
        col.meanY[i] = cY * 100 / G;
        col.meanP[i] = cP * 100 / G;
        col.eddyY[i] = cEY * 100 / G;
        col.eddyP[i] = cEP * 100 / G;
    }
    const { total, source } = sumTerms([meanY, meanP, eddyY, eddyP]);
    Object.assign(col, sumTerms([col.meanY, col.meanP, col.eddyY, col.eddyP]));
    return { meanY, meanP, eddyY, eddyP, total, source,
             col, colMass, transport, massRemoved, ground };
}

/** Largest |value| of a set of latitude profiles (row i = 90 − i°) within
 *  RANGE_LAT of the equator, for a 1-D view's symmetric y-range. Closer to
 *  the pole the latitude bands are so small that the convergence is noise:
 *  the cap poleward of 88°, 0.03 % of the globe, turns a 0.01 PW error in
 *  the transport across 88° into 65 W/m². In single years its ±89° row
 *  reached 350–390 W/m² (Feb 2000 total, Oct 2000 eddy meridional), twice
 *  anything else, while the convergence over the Antarctic plateau (H total
 *  110–130 W/m² at 82–84°S in July, with −(LH + SH + R) at 130) stays
 *  inside the range. */
const RANGE_LAT = 85;
export function profileAbsMax(profiles) {
    let absMax = 0;
    for (const p of profiles) {
        for (let i = 90 - RANGE_LAT; i <= 90 + RANGE_LAT; i++) {
            const v = p[i];
            if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
        }
    }
    return absMax;
}

/** Sum of the terms and its negative, blank where no term is. */
function sumTerms(parts) {
    const n = parts[0].length;
    const total = new Float32Array(n), source = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0, any = false;
        for (const a of parts) if (Number.isFinite(a[i])) { s += a[i]; any = true; }
        total[i]  = any ? s : NaN;
        source[i] = any ? -s : NaN;
    }
    return { total, source };
}
