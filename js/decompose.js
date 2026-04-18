// GC-ATLAS — field decomposition helpers.
//
// Given a 2D (nlat, nlon) scalar field, produce the derived scalar for any
// of four rendering modes:
//
//   total    — the raw field, unchanged.
//   zonal    — zonal mean at each latitude (no longitude dependence).
//   eddy     — value minus the zonal mean; the stationary-wave signal.
//   anomaly  — value minus the annual (12-month) mean at the same (lat, lon);
//              the seasonal-cycle signal.
//
// All helpers are NaN-aware: land-masked samples (e.g. SST over land) drop
// out of means and pass through as NaN in the derived field, so the colormap
// continues to paint them with the no-data colour.
//
// Range is recomputed per mode. For eddy / anomaly the output is symmetric
// about zero (vmax = -vmin = max|v|), which pairs with a divergent colormap
// at the caller.

const EPS = 1e-12;

/** { values, vmin, vmax } for the input, NaN-safe. */
function statsOf(values) {
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    return { vmin, vmax };
}

/** Symmetric range around zero from the field — for diverging display. */
function symStatsOf(values) {
    let a = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        const m = Math.abs(v);
        if (m > a) a = m;
    }
    if (a < EPS) a = 1;
    return { vmin: -a, vmax: a };
}

/** Per-latitude mean of the field (Float32Array, length nlat). NaN-safe. */
function zonalMean(values, nlat, nlon) {
    const zm = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let s = 0, n = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const v = values[row + j];
            if (Number.isFinite(v)) { s += v; n += 1; }
        }
        zm[i] = n > 0 ? s / n : NaN;
    }
    return zm;
}

/**
 * Apply the decomposition mode to a field.
 * @param {Float32Array} values      — input field, row-major (nlat × nlon).
 * @param {number} nlat, nlon        — grid dims.
 * @param {string} mode              — 'total' | 'zonal' | 'eddy' | 'anomaly'.
 * @param {Float32Array} annualMean  — optional (nlat × nlon) 12-month mean
 *                                     for anomaly mode; ignored otherwise.
 * Returns { values, vmin, vmax, symmetric: bool, empty: bool }.
 *   symmetric: true if range is zero-centred (eddy, anomaly) — hint for
 *              colormap / colorbar presentation.
 *   empty:    true if the mode needs data we don't have (e.g. anomaly
 *              called without annualMean), in which case values is the
 *              original input passed through unchanged.
 */
export function decompose(values, nlat, nlon, mode, annualMean = null) {
    if (mode === 'total' || !mode) {
        const s = statsOf(values);
        return { values, vmin: s.vmin, vmax: s.vmax, symmetric: false, empty: false };
    }

    if (mode === 'zonal') {
        const zm = zonalMean(values, nlat, nlon);
        const out = new Float32Array(nlat * nlon);
        for (let i = 0; i < nlat; i++) {
            const v = zm[i];
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) out[row + j] = v;
        }
        const s = statsOf(out);
        return { values: out, vmin: s.vmin, vmax: s.vmax, symmetric: false, empty: false };
    }

    if (mode === 'eddy') {
        const zm = zonalMean(values, nlat, nlon);
        const out = new Float32Array(nlat * nlon);
        for (let i = 0; i < nlat; i++) {
            const mean = zm[i];
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                const v = values[row + j];
                out[row + j] = Number.isFinite(v) && Number.isFinite(mean) ? (v - mean) : NaN;
            }
        }
        const s = symStatsOf(out);
        return { values: out, vmin: s.vmin, vmax: s.vmax, symmetric: true, empty: false };
    }

    if (mode === 'anomaly') {
        if (!annualMean) {
            const s = statsOf(values);
            return { values, vmin: s.vmin, vmax: s.vmax, symmetric: false, empty: true };
        }
        const out = new Float32Array(nlat * nlon);
        const n = values.length;
        for (let i = 0; i < n; i++) {
            const v = values[i];
            const m = annualMean[i];
            out[i] = Number.isFinite(v) && Number.isFinite(m) ? (v - m) : NaN;
        }
        const s = symStatsOf(out);
        return { values: out, vmin: s.vmin, vmax: s.vmax, symmetric: true, empty: false };
    }

    // Unknown mode — pass through.
    const s = statsOf(values);
    return { values, vmin: s.vmin, vmax: s.vmax, symmetric: false, empty: false };
}

/**
 * Compute the annual (12-month) mean of a field at a fixed (name, level) by
 * averaging whatever tiles are currently available. Requires a getter that
 * returns { values } for a given month (or null if the tile isn't in cache).
 *
 * getMonth(month) → Float32Array | null
 *
 * Returns Float32Array (nlat × nlon) of the mean, or null if no months are
 * cached yet. Uses only the months that are cached; caller can re-invoke
 * once more tiles arrive.
 */
export function annualMeanFrom(getMonth, nlat, nlon) {
    const N = nlat * nlon;
    const sum = new Float32Array(N);
    const count = new Uint8Array(N);
    let haveAny = false;
    for (let m = 1; m <= 12; m++) {
        const v = getMonth(m);
        if (!v) continue;
        haveAny = true;
        for (let i = 0; i < N; i++) {
            const x = v[i];
            if (Number.isFinite(x)) { sum[i] += x; count[i] += 1; }
        }
    }
    if (!haveAny) return null;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = count[i] > 0 ? sum[i] / count[i] : NaN;
    return out;
}
