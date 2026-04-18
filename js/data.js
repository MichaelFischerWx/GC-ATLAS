// Synthetic "ERA5-like" fields for renderer development.
// These are NOT real reanalysis data — they produce pedagogically plausible
// shapes (mid-latitude jets, Hadley return, stationary waves, subtropical highs)
// so we can build and validate the renderer before the ERA5 climatology lands.
// When ERA5 is staged, swap the getField() body for a Zarr loader.

export const GRID = { nlat: 181, nlon: 360 };
export const LEVELS = [10, 50, 100, 150, 200, 250, 300, 500, 700, 850, 925, 1000];
export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export const FIELDS = {
    t:   { type: 'pl', name: 'Temperature',            units: 'K',     cmap: 'turbo',   defaultLevel: 500 },
    u:   { type: 'pl', name: 'Zonal wind (u)',         units: 'm s⁻¹', cmap: 'RdBu_r',  defaultLevel: 200 },
    v:   { type: 'pl', name: 'Meridional wind (v)',    units: 'm s⁻¹', cmap: 'RdBu_r',  defaultLevel: 200 },
    z:   { type: 'pl', name: 'Geopotential height',    units: 'm',     cmap: 'viridis', defaultLevel: 500 },
    msl: { type: 'sl', name: 'Mean sea-level pressure', units: 'hPa',  cmap: 'plasma' },
    t2m: { type: 'sl', name: '2-m temperature',        units: 'K',     cmap: 'turbo' },
};

// ── lat/lon axes ─────────────────────────────────────────────────────────
const LATS = new Float32Array(GRID.nlat);
const LONS = new Float32Array(GRID.nlon);
for (let i = 0; i < GRID.nlat; i++) LATS[i] = 90 - i;
for (let j = 0; j < GRID.nlon; j++) LONS[j] = -180 + j;

const D2R = Math.PI / 180;

function seasonalPhase(month) {
    // +1 in Jan (boreal winter), -1 in Jul (boreal summer).
    return Math.cos(2 * Math.PI * (month - 1) / 12);
}

function zFromPressure(p) {
    // Scale-height: z ≈ 7.2 km · ln(1013/p); rough but monotonic.
    return 7200 * Math.log(1013.25 / p);
}

// ── field builders ───────────────────────────────────────────────────────

function fieldT(month, level) {
    const z = zFromPressure(level);
    const T0 = 288.15 - 6.5e-3 * Math.min(z, 11000);
    const s = seasonalPhase(month);
    const values = new Float32Array(GRID.nlat * GRID.nlon);
    for (let i = 0; i < GRID.nlat; i++) {
        const latR = LATS[i] * D2R;
        const meridional = 30 * Math.cos(latR) ** 2;
        const seasonal = -18 * s * Math.sin(latR);
        const base = T0 + meridional + seasonal;
        for (let j = 0; j < GRID.nlon; j++) {
            const lonR = LONS[j] * D2R;
            values[i * GRID.nlon + j] = base + 1.5 * Math.sin(2 * lonR);
        }
    }
    return { values, vmin: 180, vmax: 310 };
}

function fieldU(month, level) {
    const z = zFromPressure(level);
    const jetStrength = Math.min(1, Math.max(0, z / 10000));
    const s = seasonalPhase(month);
    const values = new Float32Array(GRID.nlat * GRID.nlon);
    for (let i = 0; i < GRID.nlat; i++) {
        const lat = LATS[i];
        const latR = lat * D2R;
        const nh = 40 * jetStrength * Math.exp(-(((lat - 40) / 15) ** 2)) * (1 + 0.45 * s);
        const sh = 35 * jetStrength * Math.exp(-(((lat + 40) / 15) ** 2)) * (1 - 0.45 * s);
        const trop = -4 * jetStrength * Math.exp(-((lat / 20) ** 2));
        const base = nh + sh + trop;
        for (let j = 0; j < GRID.nlon; j++) {
            const lonR = LONS[j] * D2R;
            const wave = 3 * Math.cos(2 * lonR) * Math.cos(latR);
            values[i * GRID.nlon + j] = base + wave;
        }
    }
    return { values, vmin: -40, vmax: 60 };
}

function fieldV(month, level) {
    const z = zFromPressure(level);
    const upper = Math.tanh((z - 5000) / 5000); // −1 near surface, +1 aloft
    const s = seasonalPhase(month);
    const values = new Float32Array(GRID.nlat * GRID.nlon);
    for (let i = 0; i < GRID.nlat; i++) {
        const latR = LATS[i] * D2R;
        const hadley = -3.5 * Math.sin(3 * latR) * Math.exp(-Math.abs(LATS[i]) / 45);
        const seasonalShift = -2 * s * Math.sin(2 * latR);
        const base = upper * hadley + seasonalShift;
        for (let j = 0; j < GRID.nlon; j++) {
            const lonR = LONS[j] * D2R;
            values[i * GRID.nlon + j] = base + 0.8 * Math.sin(2 * lonR);
        }
    }
    return { values, vmin: -6, vmax: 6 };
}

function fieldZ(month, level) {
    const baseZ = zFromPressure(level);
    const s = seasonalPhase(month);
    const latRange = 400;
    const values = new Float32Array(GRID.nlat * GRID.nlon);
    for (let i = 0; i < GRID.nlat; i++) {
        const latR = LATS[i] * D2R;
        const zonal = baseZ - latRange * (1 - Math.cos(latR) ** 2) - 80 * s * Math.sin(latR);
        for (let j = 0; j < GRID.nlon; j++) {
            const lonR = LONS[j] * D2R;
            const wave = (60 * Math.cos(latR) ** 2) * Math.cos(2 * lonR + Math.PI / 4)
                       + (30 * Math.cos(latR) ** 2) * Math.cos(3 * lonR);
            values[i * GRID.nlon + j] = zonal + wave;
        }
    }
    return { values, vmin: baseZ - 500, vmax: baseZ + 200 };
}

function fieldMSL(month) {
    const s = seasonalPhase(month);
    const values = new Float32Array(GRID.nlat * GRID.nlon);
    for (let i = 0; i < GRID.nlat; i++) {
        const lat = LATS[i];
        const latR = lat * D2R;
        const subHigh = 18 * Math.exp(-(((Math.abs(lat) - 30) / 12) ** 2));
        const eqLow = -4 * Math.exp(-((lat / 10) ** 2));
        const polar = -6 * s * Math.exp(-(((lat - 65) / 15) ** 2))
                    +  6 * s * Math.exp(-(((lat + 65) / 15) ** 2));
        const zonal = 1013 + subHigh + eqLow + polar;
        for (let j = 0; j < GRID.nlon; j++) {
            const lonR = LONS[j] * D2R;
            // Crude Aleutian (~170°E → 2.97 rad) and Icelandic (~340°E = -20° → -0.35 rad) lows.
            const lonAl = lonR - 2.97, lonIs = lonR + 0.35;
            const alask = -10 * s * Math.exp(-(((lat - 55) / 15) ** 2))
                         * Math.exp(-((lonAl / 0.8) ** 2));
            const iceld =  -8 * s * Math.exp(-(((lat - 62) / 15) ** 2))
                         * Math.exp(-((lonIs / 0.7) ** 2));
            values[i * GRID.nlon + j] = zonal + alask + iceld;
        }
    }
    return { values, vmin: 985, vmax: 1035 };
}

function fieldT2M(month) {
    const s = seasonalPhase(month);
    const values = new Float32Array(GRID.nlat * GRID.nlon);
    for (let i = 0; i < GRID.nlat; i++) {
        const lat = LATS[i];
        const latR = lat * D2R;
        const mean = 288 + 22 * Math.cos(latR) ** 2 - 40 * (1 - Math.cos(latR) ** 2);
        const seasonal = -22 * s * Math.sin(latR);
        const base = mean + seasonal;
        for (let j = 0; j < GRID.nlon; j++) {
            const lonR = LONS[j] * D2R;
            // Continental cold pools (crude — around Asia ~+90° and N. America ~−95°)
            const asia = Math.exp(-(((lonR - 1.57) / 0.9) ** 2));
            const noam = Math.exp(-(((lonR + 1.66) / 0.9) ** 2));
            const continental = -10 * s * Math.max(0, Math.sin(latR)) * (asia + noam);
            values[i * GRID.nlon + j] = base + continental;
        }
    }
    return { values, vmin: 220, vmax: 315 };
}

// ── public API ───────────────────────────────────────────────────────────

/** Return { values, vmin, vmax, shape, lats, lons, name, units, cmap, type }. */
export function getField(name, { month = 1, level = 500 } = {}) {
    const meta = FIELDS[name];
    if (!meta) throw new Error(`unknown field: ${name}`);
    let data;
    switch (name) {
        case 't':   data = fieldT(month, level); break;
        case 'u':   data = fieldU(month, level); break;
        case 'v':   data = fieldV(month, level); break;
        case 'z':   data = fieldZ(month, level); break;
        case 'msl': data = fieldMSL(month); break;
        case 't2m': data = fieldT2M(month); break;
        default:    throw new Error(`no generator for ${name}`);
    }
    return {
        ...data,
        shape: [GRID.nlat, GRID.nlon],
        lats: LATS, lons: LONS,
        ...meta,
    };
}
