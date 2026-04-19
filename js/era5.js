// GC-ATLAS — ERA5 tile loader (async fetch + in-memory cache).
// Serves real ERA5 climatology tiles to the globe, with a subscribe-on-ready
// pattern so callers can keep a synchronous API: they get synthetic data until
// the real tile lands, then we fire an event and they re-render.

const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

// Multi-period tile trees. The 'default' period is our 1991-2020 climatology
// (present from day 1). Additional periods (e.g. '1961-1990') get their own
// cache + manifest so reference-period anomalies can be computed without
// confusing the primary loader.
function tileBaseFor(period) {
    if (period === 'default') {
        return IS_LOCAL ? 'data/tiles' : 'https://storage.googleapis.com/gc-atlas-era5/tiles';
    }
    // Period like '1961-1990' → folder 'tiles_1961_1990'.
    const folder = `tiles_${period.replace('-', '_')}`;
    return IS_LOCAL ? `data/${folder}` : `https://storage.googleapis.com/gc-atlas-era5/${folder}`;
}

const manifests = new Map();    // period → manifest JSON (or null while loading)
const cache = new Map();        // key (with period prefix) → { values } | 'pending'
const subscribers = new Set();  // fns({ name, month, level, period })

// Back-compat: many callers still reference `manifest` as the default tree.
// Keep a getter that returns the default-period manifest.
let manifest = null;

const pad = (n) => String(n).padStart(2, '0');
// Cache key includes period + kind so a single field can hold mean/std and
// multiple base periods concurrently for the same (month, level).
const keyOf = (name, month, level, kind = 'mean', period = 'default') =>
    level == null
        ? `${period}|${name}|sl|${month}|${kind}`
        : `${period}|${name}|${level}|${month}|${kind}`;

/** Load the manifest for a period (default or a reference). Returns true if found. */
export async function loadManifest(period = 'default') {
    if (manifests.has(period) && manifests.get(period)) {
        if (period === 'default') manifest = manifests.get(period);
        return true;
    }
    try {
        const resp = await fetch(`${tileBaseFor(period)}/manifest.json`, { cache: 'no-cache' });
        if (!resp.ok) {
            manifests.set(period, null);
            return false;
        }
        const m = await resp.json();
        manifests.set(period, m);
        if (period === 'default') manifest = m;
        return true;
    } catch (_err) {
        manifests.set(period, null);
        return false;
    }
}

export function isReady(period = 'default') { return !!manifests.get(period); }

/** Return { group, meta } for a short name in a given period's manifest. */
function resolveField(name, period = 'default') {
    const m = manifests.get(period);
    if (!m) return null;
    for (const [group, vars_] of Object.entries(m.groups)) {
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

/** Cached-only lookup — no fetch side-effect. Returns Float32Array | null. */
export function cachedMonth(name, month, level = null, kind = 'mean', period = 'default') {
    const r = resolveField(name, period);
    if (!r) return null;
    const useLevel = r.meta.levels ? level : null;
    const hit = cache.get(keyOf(name, month, useLevel, kind, period));
    return hit && hit !== 'pending' ? hit.values : null;
}

/**
 * Return the field synchronously if cached; otherwise kick off a fetch,
 * return null, and notify subscribers when the tile arrives.
 */
export function requestField(name, { month, level, kind = 'mean', period = 'default' } = {}) {
    const r = resolveField(name, period);
    if (!r) return null;
    const useLevel = r.meta.levels ? level : null;
    const key = keyOf(name, month, useLevel, kind, period);
    const hit = cache.get(key);
    if (hit && hit !== 'pending') {
        const agg = aggregateStats(name, useLevel, kind, period);
        return {
            values: hit.values,
            vmin: agg ? agg.vmin : hit.vmin,
            vmax: agg ? agg.vmax : hit.vmax,
            shape: r.meta.shape,
            units: r.meta.units,
            long_name: r.meta.long_name,
            lat_descending: r.meta.lat_descending,
            isReal: true,
            kind,
            period,
        };
    }
    if (!hit) fetchTile(name, r.group, r.meta, month, useLevel, kind, period);
    return null;
}

async function fetchTile(name, group, meta, month, level, kind = 'mean', period = 'default') {
    const key = keyOf(name, month, level, kind, period);
    cache.set(key, 'pending');
    const stdPrefix = kind === 'std' ? 'std_' : '';
    const base = tileBaseFor(period);
    const url = meta.levels
        ? `${base}/${group}/${name}/${stdPrefix}${level}_${pad(month)}.bin`
        : `${base}/${group}/${name}/${stdPrefix}${pad(month)}.bin`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const values = new Float32Array(buf);
        // Apply the same unit conversions to std tiles — std of a linear
        // transform is the same transform of the std (modulo abs sign), so
        // multiplying by 1000 (q) or dividing by DAY (radiative fluxes) is
        // valid for both mean and std variants.
        applyUnitConversions(name, values);
        // Per-tile colorbar range. For most fields we use the true min/max,
        // but a few (vorticity, divergence, vertical velocity, precipitation)
        // are dominated by isolated topographic / convective spikes that
        // squash the colorbar — for those we use a percentile clamp set in
        // the FIELDS metadata as `clamp: { lo, hi }` (fractions in [0,1]).
        const clamp = CLAMPS.get(name);
        let vmin, vmax;
        if (clamp) {
            [vmin, vmax] = percentileBounds(values, clamp.lo, clamp.hi);
        } else {
            vmin = Infinity; vmax = -Infinity;
            for (let i = 0; i < values.length; i++) {
                const v = values[i];
                if (v < vmin) vmin = v;
                if (v > vmax) vmax = v;
            }
        }
        cache.set(key, { values, vmin, vmax });
        for (const fn of subscribers) fn({ name, month, level, period });
    } catch (err) {
        console.warn(`[era5] tile failed ${url}:`, err);
        cache.delete(key);
    }
}

// Per-field percentile clamp registry, populated lazily on first request from
// FIELDS metadata (avoids a circular import). Set by registerClamps() below.
const CLAMPS = new Map();
export function registerClamps(fields) {
    for (const [name, meta] of Object.entries(fields)) {
        if (meta.clamp) CLAMPS.set(name, meta.clamp);
    }
}

/** NaN-safe percentile bounds. Sorts a copy of finite values; returns
 *  [lo-percentile, hi-percentile]. lo, hi as fractions in [0, 1]. */
function percentileBounds(values, lo, hi) {
    const finite = [];
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v)) finite.push(v);
    }
    if (finite.length === 0) return [0, 1];
    finite.sort((a, b) => a - b);
    const idxLo = Math.max(0, Math.min(finite.length - 1, Math.floor(lo * (finite.length - 1))));
    const idxHi = Math.max(0, Math.min(finite.length - 1, Math.floor(hi * (finite.length - 1))));
    return [finite[idxLo], finite[idxHi]];
}

export function onFieldLoaded(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

/** Aggregate vmin/vmax across every cached month at (name, level, kind, period). */
function aggregateStats(name, level, kind = 'mean', period = 'default') {
    const prefix = level == null
        ? `${period}|${name}|sl|`
        : `${period}|${name}|${level}|`;
    const suffix = `|${kind}`;
    let vmin = Infinity, vmax = -Infinity, any = false;
    for (const [key, val] of cache.entries()) {
        if (!val || typeof val !== 'object') continue;
        if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
        if (val.vmin < vmin) vmin = val.vmin;
        if (val.vmax > vmax) vmax = val.vmax;
        any = true;
    }
    return any ? { vmin, vmax } : null;
}

/** Kick off fetches for many months in parallel (for the "play" seasonal cycle). */
export function prefetchField(name, { level = null, months = [1,2,3,4,5,6,7,8,9,10,11,12], kind = 'mean', period = 'default' } = {}) {
    const r = resolveField(name, period);
    if (!r) return;
    if (kind === 'std' && r.meta.has_std === false) return;
    const useLevel = r.meta.levels ? level : null;
    for (const m of months) {
        const key = keyOf(name, m, useLevel, kind, period);
        if (!cache.has(key)) fetchTile(name, r.group, r.meta, m, useLevel, kind, period);
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
    if (name === 'z' || name === 'oro') {
        // ERA5 geopotential (m² s⁻²) → geopotential height (m).
        // 'oro' is the surface geopotential (model orography invariant).
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
    } else if (name === 'ews') {
        // Eastward turbulent surface stress: monthly mean in N m⁻² s
        // (accumulated over a day). Divide by DAY to get instantaneous N m⁻².
        for (let i = 0; i < n; i++) values[i] /= DAY;
    } else if (name === 'q') {
        // kg/kg → g/kg (typical surface tropics ≈ 18 g/kg, stratosphere ≈ 0)
        for (let i = 0; i < n; i++) values[i] *= 1000;
    } else if (name === 'd' || name === 'vo') {
        // s⁻¹ → 10⁻⁵ s⁻¹ (gen-circ teaching unit; mid-trop ζ scales ~10⁻⁵)
        for (let i = 0; i < n; i++) values[i] *= 1e5;
    } else if (name === 'chi' || name === 'psi') {
        // m² s⁻¹ → 10⁶ m² s⁻¹ ("Mm²/s") for readability. 200 hPa ψ peaks
        // at ±100 Mm²/s; χ peaks ~±10 Mm²/s.
        for (let i = 0; i < n; i++) values[i] /= 1e6;
    } else if (name === 'pv') {
        // K m² kg⁻¹ s⁻¹ → PVU (1 PVU = 10⁻⁶ K m² kg⁻¹ s⁻¹). Tropopause sits
        // around 2 PVU; stratospheric values reach 10+ PVU.
        for (let i = 0; i < n; i++) values[i] *= 1e6;
    }
}
