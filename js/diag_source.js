// GC-ATLAS — the time slice a diagnostic reads.
//
// The cross-section diagnostics (ψ, M, [u_g], N², EP flux, budgets) and the
// Lorenz panel compute from whatever the globe is showing: the active
// climatology, one year, or a composite / custom range. A "source" names
// that slice:
//
//   null                  active climatology (the 'default' tile tree)
//   { year: 1998 }        single year (per-year tiles)
//   { years: [...] }      NaN-safe mean over those years' per-year tiles;
//                         [] = composite still resolving (shared link
//                         waiting on indices.json)
//
// sourceMonth() is the source-aware twin of era5.js cachedMonth(): cached-
// only, never fetches, null while any tile is missing (callers prefetch and
// retry when onFieldLoaded fires). Composite diagnostics are computed from
// the composite-mean fields, the same way the climatology diagnostics are
// computed from the climatological-mean fields — the "stationary" eddies are
// departures of the composite-mean flow from its zonal mean.

import { cachedMonth, perYearHasMonth, windowSlots, windowMean, rememberWindowMean } from './era5.js';
import { customRangeYears } from './data.js';

/** Source descriptor for the globe's current time selection. */
export function sourceFromState(s) {
    if (s.year != null) return { year: s.year };
    if (s.customRange) return { years: customRangeYears(s.customRange) };
    return null;
}

/** Stable key for caches and source comparisons. */
export function sourceKey(src) {
    if (!src) return 'climo';
    if (src.year != null) return `y${src.year}`;
    return `ys=${(src.years || []).join(',')}`;
}

/** Years of a per-year source whose `month` is in the archive (for `name`,
 *  if given). [] for the climatology. */
export function sourceYears(src, month, name = null) {
    if (!src) return [];
    const ys = src.year != null ? [src.year] : (src.years || []);
    return ys.filter(y => perYearHasMonth(y, month, name));
}

/** Can this source ever supply `month`? False for a single year whose month
 *  isn't published (or is outside the archive), or a composite none of whose
 *  years has it — the panel should say so instead of "Loading" forever. A
 *  composite still resolving its years counts as available. */
export function sourceHasMonth(src, month, name = null) {
    if (!src) return true;
    if (src.year == null && !(src.years || []).length) return true;
    return sourceYears(src, month, name).length > 0;
}

/** `src` moved `offset` calendar years — every year of a composite alike.
 *  The climatology has no years to move. */
export function shiftSource(src, offset) {
    if (!src || !offset) return src;
    if (src.year != null) return { year: src.year + offset };
    return { years: (src.years || []).map(y => y + offset) };
}

/** The months of the window centred on `month` (era5.js windowSlots) that
 *  `src` can supply, each with the source to read it from: [{ month, src }].
 *  A year's or composite's 3-month season crosses the calendar year — DJF
 *  1998 reads Dec 1997, a composite's DJF the December before each of its
 *  years. Every month for the climatology; a year's or composite's months in
 *  the per-year archive otherwise, so an annual mean of the current year
 *  averages what exists and DJF 1961 (no Dec 1960) its Jan and Feb. */
export function sourceWindow(src, month, seasonal = false, name = null) {
    const out = [];
    for (const { month: m, offset } of windowSlots(month, seasonal)) {
        const s = shiftSource(src, offset);
        if (sourceHasMonth(s, m, name)) out.push({ month: m, src: s });
    }
    return out;
}

/** Months of the window that `src` can supply (see sourceWindow). */
export function sourceWindowMonths(src, month, seasonal = false, name = null) {
    return sourceWindow(src, month, seasonal, name).map(w => w.month);
}

/** Cached tile for (name, month, level) from `src`. `seasonal` averages the
 *  three months centred on `month`, or all twelve with 'annual' (NaN-safe).
 *  Per-year sources take each month from its own calendar year, like the
 *  globe's seasonal view (sourceWindow: DJF 1998 = Dec 1997 + Jan + Feb
 *  1998), and skip months outside the archive rather than waiting on them. */
export function sourceMonth(name, month, level, src, seasonal = false) {
    if (!src) return cachedMonth(name, month, level, 'mean', 'default', null, seasonal);
    if (seasonal) {
        const win = sourceWindow(src, month, seasonal, name);
        // Computed once per window (era5.js window-mean cache): the panels
        // redraw on every tile arrival.
        const key = `src|${name}|${level}|${win.map(w => `${sourceKey(w.src)}:${w.month}`).join(',')}`;
        const hit = windowMean(key);
        if (hit) return hit;
        const tiles = [];
        for (const { month: m, src: s } of win) {
            const t = sourceMonth(name, m, level, s, false);
            if (!t) return null;
            tiles.push(t);
        }
        if (!tiles.length) return null;
        if (tiles.length === 1) return tiles[0];
        const N = tiles[0].length;
        const out = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            let s = 0, n = 0;
            for (const t of tiles) {
                const v = t[i];
                if (Number.isFinite(v)) { s += v; n += 1; }
            }
            out[i] = n > 0 ? s / n : NaN;
        }
        rememberWindowMean(key, out);
        return out;
    }
    if (src.year != null) {
        if (!perYearHasMonth(src.year, month, name)) return null;
        return cachedMonth(name, month, level, 'mean', 'per_year', src.year);
    }
    return compositeMonth(name, month, level, src.years || []);
}

// Composite means, keyed by (name, level, month, years). Per-year tiles
// don't depend on the active climatology, so neither does the key. Bounded
// LRU: one composite month of the MSE budget is ~80 tiles of 260 KB.
const MAX_COMPOSITE_TILES = 400;
const _composites = new Map();

/** NaN-safe mean of the per-year tiles over `years`, skipping years whose
 *  month isn't in the archive (cf. data.js composeCustomRangeMean). Null
 *  while any tile is still loading, or when no year has the month. */
function compositeMonth(name, month, level, years) {
    const key = `${name}|${level ?? 'sl'}|${month}|${years.join(',')}`;
    const hit = _composites.get(key);
    if (hit) {
        _composites.delete(key);
        _composites.set(key, hit);
        return hit;
    }
    let sum = null, cnt = null;
    for (const y of years) {
        if (!perYearHasMonth(y, month, name)) continue;
        const t = cachedMonth(name, month, level, 'mean', 'per_year', y);
        if (!t) return null;
        if (!sum) {
            sum = new Float64Array(t.length);
            cnt = new Uint16Array(t.length);
        }
        for (let i = 0; i < t.length; i++) {
            const v = t[i];
            if (Number.isFinite(v)) { sum[i] += v; cnt[i] += 1; }
        }
    }
    if (!sum) return null;
    const out = new Float32Array(sum.length);
    for (let i = 0; i < out.length; i++) out[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
    _composites.set(key, out);
    while (_composites.size > MAX_COMPOSITE_TILES) {
        _composites.delete(_composites.keys().next().value);
    }
    return out;
}
