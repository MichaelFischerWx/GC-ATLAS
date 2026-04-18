// GC-ATLAS — ERA5 tile loader (async fetch + in-memory cache).
// Serves real ERA5 climatology tiles to the globe, with a subscribe-on-ready
// pattern so callers can keep a synchronous API: they get synthetic data until
// the real tile lands, then we fire an event and they re-render.

const TILE_BASE = 'data/tiles';

let manifest = null;
const cache = new Map();        // key -> { values } | 'pending'
const subscribers = new Set();  // fns(name, month, level)

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (name, month, level) =>
    level == null ? `${name}|sl|${month}` : `${name}|${level}|${month}`;

/** Load the top-level manifest; returns true if it was found. */
export async function loadManifest() {
    if (manifest) return true;
    try {
        const resp = await fetch(`${TILE_BASE}/manifest.json`, { cache: 'no-cache' });
        if (!resp.ok) return false;
        manifest = await resp.json();
        return true;
    } catch (_err) {
        return false;
    }
}

export function isReady() { return !!manifest; }

/** Return { group, meta } for a short name, or null if not in the manifest. */
function resolveField(name) {
    if (!manifest) return null;
    for (const [group, vars_] of Object.entries(manifest.groups)) {
        if (vars_[name]) return { group, meta: vars_[name] };
    }
    return null;
}

/** Short names the manifest currently lists. */
export function availableFields() {
    if (!manifest) return [];
    const out = [];
    for (const vars_ of Object.values(manifest.groups)) {
        for (const name of Object.keys(vars_)) out.push(name);
    }
    return out;
}

/** Levels present for a pressure-level variable (or null). */
export function availableLevels(name) {
    const r = resolveField(name);
    return r && r.meta.levels ? r.meta.levels.slice() : null;
}

/**
 * Return the field synchronously if cached; otherwise kick off a fetch,
 * return null, and notify subscribers when the tile arrives.
 */
export function requestField(name, { month, level } = {}) {
    const r = resolveField(name);
    if (!r) return null;
    const useLevel = r.meta.levels ? level : null;
    const key = keyOf(name, month, useLevel);
    const hit = cache.get(key);
    if (hit && hit !== 'pending') {
        // Aggregate range across every cached month at this (field, level) so
        // the colorbar stays fixed while the user scrubs / auto-plays months.
        const agg = aggregateStats(name, useLevel);
        return {
            values: hit.values,
            vmin: agg ? agg.vmin : hit.vmin,
            vmax: agg ? agg.vmax : hit.vmax,
            shape: r.meta.shape,
            units: r.meta.units,
            long_name: r.meta.long_name,
            lat_descending: r.meta.lat_descending,
            isReal: true,
        };
    }
    if (!hit) fetchTile(name, r.group, r.meta, month, useLevel);
    return null;
}

async function fetchTile(name, group, meta, month, level) {
    const key = keyOf(name, month, level);
    cache.set(key, 'pending');
    const url = meta.levels
        ? `${TILE_BASE}/${group}/${name}/${level}_${pad(month)}.bin`
        : `${TILE_BASE}/${group}/${name}/${pad(month)}.bin`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const values = new Float32Array(buf);
        applyUnitConversions(name, values);
        // Per-tile range so each (field, month, level) uses the full colormap.
        let vmin = Infinity, vmax = -Infinity;
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (v < vmin) vmin = v;
            if (v > vmax) vmax = v;
        }
        cache.set(key, { values, vmin, vmax });
        for (const fn of subscribers) fn({ name, month, level });
    } catch (err) {
        console.warn(`[era5] tile failed ${url}:`, err);
        cache.delete(key);
    }
}

export function onFieldLoaded(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

/** Aggregate vmin/vmax across every cached month at (name, level). Returns null if none yet. */
function aggregateStats(name, level) {
    const prefix = level == null ? `${name}|sl|` : `${name}|${level}|`;
    let vmin = Infinity, vmax = -Infinity, any = false;
    for (const [key, val] of cache.entries()) {
        if (!val || typeof val !== 'object') continue;
        if (!key.startsWith(prefix)) continue;
        if (val.vmin < vmin) vmin = val.vmin;
        if (val.vmax > vmax) vmax = val.vmax;
        any = true;
    }
    return any ? { vmin, vmax } : null;
}

/** Kick off fetches for many months in parallel (for the "play" seasonal cycle). */
export function prefetchField(name, { level = null, months = [1,2,3,4,5,6,7,8,9,10,11,12] } = {}) {
    const r = resolveField(name);
    if (!r) return;
    const useLevel = r.meta.levels ? level : null;
    for (const m of months) {
        const key = keyOf(name, m, useLevel);
        if (!cache.has(key)) fetchTile(name, r.group, r.meta, m, useLevel);
    }
}

// ── per-variable unit normalisations ─────────────────────────────────────
// Applied once at tile load, before caching, so all downstream code sees
// values in the units advertised in data.js FIELDS metadata.
const G   = 9.80665;
const DAY = 86400;
const RADIATIVE_FLUX_VARS = new Set(['sshf', 'slhf', 'ssr', 'str', 'tisr', 'ttr']);

function applyUnitConversions(name, values) {
    const n = values.length;
    if (name === 'z') {
        // ERA5 geopotential (m² s⁻²) → geopotential height (m)
        for (let i = 0; i < n; i++) values[i] /= G;
    } else if (name === 'msl' || name === 'sp') {
        // Pa → hPa
        for (let i = 0; i < n; i++) values[i] /= 100;
    } else if (name === 'tp') {
        // Monthly means provide m per day — convert to mm/day.
        for (let i = 0; i < n; i++) values[i] *= 1000;
    } else if (RADIATIVE_FLUX_VARS.has(name)) {
        // Monthly means provide J m⁻² per day — convert to W m⁻².
        for (let i = 0; i < n; i++) values[i] /= DAY;
    }
}
