// GC-ATLAS — climate-index lookup for the composite builder.
//
// Loads data/indices.json (a small static file built by
// pipeline/update_indices.py from NOAA PSL + CPC sources) and exposes
// a query API so the frontend can derive event-year lists from an
// index + comparator + threshold in a chosen month.
//
// Values are indexed by central month of the source series (ONI/RONI
// are 3-month running means anchored to their central month; AO/NAO/PNA
// are already monthly values). This means the query is always
// one-month-resolution — no seasonal smoothing added or removed here.

let _cache = null;       // resolved JSON payload
let _pending = null;     // in-flight promise

const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
// The monthly refresh (bin/era5-monthly-refresh.sh) republishes indices.json
// to the tile bucket, so the deployed site picks up new index months
// without a git push. The copy in the repo is the fallback.
const SOURCES = IS_LOCAL
    ? ['data/indices.json']
    : ['https://storage.googleapis.com/gc-atlas-era5/indices.json', 'data/indices.json'];

/** Load indices.json exactly once. Resolves to the payload (empty if no
 *  source answered, e.g. the repo was opened without running
 *  pipeline/update_indices.py). */
export async function loadIndices() {
    if (_cache) return _cache;
    if (_pending) return _pending;
    _pending = (async () => {
        for (const url of SOURCES) {
            try {
                const resp = await fetch(url, { cache: 'no-cache' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                _cache = await resp.json();
                return _cache;
            } catch (err) {
                console.warn(`[indices] load failed (${url}):`, err);
            }
        }
        _cache = { updated: null, indices: {} };
        return _cache;
    })();
    return _pending;
}

/** Last { year, month } with a value in the named index, or null. */
export function lastIndexMonth(id) {
    const ix = getIndex(id);
    if (!ix) return null;
    const years = Object.keys(ix.values).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
    for (const y of years) {
        const row = ix.values[String(y)] || [];
        for (let m = 12; m >= 1; m--) {
            if (row[m - 1] != null && Number.isFinite(row[m - 1])) return { year: y, month: m };
        }
    }
    return null;
}

export function getIndex(id) {
    if (!_cache) return null;
    return _cache.indices?.[id] || null;
}

export function listIndices() {
    if (!_cache) return [];
    return Object.entries(_cache.indices || {}).map(([id, meta]) => ({
        id,
        label: meta.label,
        long_name: meta.long_name,
        description: meta.description,
        source: meta.source,
    }));
}

/** Every calendar year present in the named index's series, sorted. */
export function availableYears(id) {
    const ix = getIndex(id);
    if (!ix) return [];
    return Object.keys(ix.values).map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
}

/** Index value for (id, year, month). Returns null when the source
 *  series has a gap (missing tile, leading years of a new-ish index,
 *  or the trailing months of the current year that haven't been
 *  published yet). */
export function indexValue(id, year, month) {
    const ix = getIndex(id);
    if (!ix) return null;
    const row = ix.values[String(year)];
    if (!row) return null;
    const v = row[month - 1];
    return (v == null || !Number.isFinite(v)) ? null : v;
}

/** Years where the chosen index passes the comparator/threshold test
 *  in the given calendar month. e.g. eventYears('roni', 1, 'ge', 1.0)
 *  → years where Jan-centered RONI (= DJF) ≥ +1.0. */
export function eventYears(id, month, cmp, threshold) {
    const ix = getIndex(id);
    if (!ix) return [];
    const test = cmp === 'ge'
        ? (v) => v >= threshold
        : (v) => v <= threshold;
    const out = [];
    for (const [yStr, row] of Object.entries(ix.values)) {
        const v = row[month - 1];
        if (v == null || !Number.isFinite(v)) continue;
        if (test(v)) out.push(Number(yStr));
    }
    out.sort((a, b) => a - b);
    return out;
}

/** Short label like "RONI ≥ +1.0 · Jan" for the status panel + URL state. */
export function compositeLabel(id, month, cmp, threshold) {
    const ix = getIndex(id);
    const lbl = ix?.label || id.toUpperCase();
    const sign = cmp === 'ge' ? '≥' : '≤';
    const tStr = (threshold >= 0 ? '+' : '') + threshold.toFixed(1);
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${lbl} ${sign} ${tStr} · ${MON[month - 1]}`;
}
