# GC-ATLAS — Roadmap

Last update: 2026-04-19 (added χ/ψ, ±1σ variability, Q+H budgets, friction/mountain torques, geostrophic wind, PV refactor, multi-period scaffolding for 1961–1990 climate-change view)

## Where we are

**Live locally** via `python -m http.server 8000` → `http://localhost:8000/globe.html`.
**Public site** on GitHub Pages: https://michaelfischerwx.github.io/GC-ATLAS/ — tiles served from `gs://gc-atlas-era5` (us-east1, public read).
GA4 wired (G-M1M3TNNJCB) on landing + globe pages.

**Data on disk:**
- `data/raw/` — 26 ERA5 monthly-mean NetCDFs (1991–2020), ~20 GB. Gitignored.
- `data/tiles/` — per-(var, level, month) Float32 binaries at 1° + std variants + `manifest.json`, ~1.3 GB. Gitignored, mirrored on GCS.
- `data/raw_1961_1990/` — 28 NetCDFs for the second period (downloaded 2026-04-19). Awaiting tile build + GCS push.

---

## What's shipped

### Views (three modes)
- **Globe** (Three.js, OrbitControls, axial tilt)
- **Map** (equirectangular, drag-to-pan, central-meridian slider, **shift-drag for arc cross-section**)
- **Orbit** ("viewer from space," Level 3) — heliocentric scene with sun + halo, dashed ecliptic, orbit-direction arrow, solstice/equinox markers, mini-Earth, terminator, latitude reference circles, subsolar marker, amber axis, cosmetic diurnal spin

### Fields
- **Pressure-level (12):** `t, u, v, w, z, q, r, vo, d, pv, chi, psi`
- **Single-level (16):** `msl, sp, t2m, d2m, sst, tcwv, tp, blh, sshf, slhf, ssr, str, tisr, ttr, ews, oro`
- **Derived:** wind speed `wspd`, **moist static energy** `MSE = c_p·T + g·z + L_v·q` (displayed as MSE/c_p in K), Ertel PV on isentropes (refactored 2026-04-19 to use raw `pv` tiles directly — no more on-the-fly ζ-from-u,v)
- All ERA5 unit conversions applied at load; `chi`/`psi` displayed in 10⁶ m²/s, `pv` in PVU
- **±1σ variability tiles** for every field — cross-month inter-annual std

### Vertical coordinate toggle
- **Pressure** (12 hPa levels) or **θ (isentropic)** on `[280, 300, 315, 330, 350, 400, 500, 700]` K

### Decomposition (Total / Zonal / Eddy / Anomaly)
- Cross-month aggregated colorbar so range stays put as user scrubs months
- **Reference-period anomaly** (when 1961-1990 tiles arrive on GCS): Anomaly mode does (current − reference) instead of (current − annual mean) → climate-change visualisation per field

### Display mode (Mean / ±1σ variability)
- Toggle in the Display group; ±1σ swaps to std tiles, forces a sequential colormap
- Decomposition disabled in σ mode (no anomaly-of-stddev)

### Wind overlays
- **Off / Particles / Barbs**

### Cross-section panel (9 diagnostic modes)
- **Field section** — zonal-mean or shift-drag great-circle arc
- **ψ — Mass streamfunction**
- **M — Angular momentum**
- **[u_g] — Geostrophic wind**
- **N² — Brunt–Väisälä (stability)**
- **EP flux (stationary eddy)** — Edmon–Hoskins–McIntyre arrows on ∇·F shading
- **Angular momentum budget** — 5-term decomposition + implied torque, with friction + mountain overlay (when ews + oro tiles present)
- **Moisture budget** — Q-budget transport terms + E−P overlay
- **Energy budget (MSE)** — H-budget transport terms + LH+SH+R_TOA−R_SFC overlay

Each budget supports: term selector (mean/eddy × meridional/vertical, total, residual, all-terms overlay), display variable (∂u/∂t vs ∂M/∂t for M-budget), aggregation (lat-p heatmap, mass-weighted column mean, vertical integral with N/m² or W/m² units).

Cross-section panel: **expand-to-fullscreen toggle**, **hover readout** (lat, p, value), info popovers for M-budget and Lorenz with formulas + literature references.

### Other diagnostics
- **Lagrangian parcels** (Alt+click globe)
- **Hover readout** on globe + map
- **Contour overlay** (anti-aliased GLSL)
- **Lorenz energy cycle panel** (stationary eddies) with reference-state toggle (Lorenz-sorted vs area-mean), info popover

### Sharing
- **GIF export** — animated or annual-cycle

---

## Pending / In flight

### 1961–1990 second climatology (overnight 2026-04-18 → 2026-04-19)
- ✅ Pipeline scripts updated with `--period START-END` flag (2026-04-19)
- ✅ Frontend reference-period dropdown + climate-change-anomaly logic wired
- ✅ Raw NetCDFs downloaded to `data/raw_1961_1990/` (28 vars including ews + oro)
- 🟡 **Pending: tile build** (user runs `python pipeline/build_tiles.py --period 1961-1990` for both groups, then `pipeline/build_helmholtz.py --period 1961-1990`)
- 🟡 **Pending: GCS push** (`gcloud storage cp -r data/tiles_1961_1990 gs://gc-atlas-era5/`)
- After push + hard reload, the **Anomaly reference** dropdown's `vs. 1961–1990 (climate change)` option will work for raw fields. Derived fields (wspd, mse, pv) fall back to self-anomaly in reference mode.

---

## Next steps

### Small polish (can do anytime)

1. **Dark coastline on dark colormap fallback** — black coastlines vanish over viridis/magma. Auto-switch to white (or half-tone) on dark cmaps.
2. **Bundle `ne_50m_coastline.geojson` locally** instead of fetching from jsdelivr (~2 MB on every page load). Push through GCS or commit.
3. **Favicon** (still 404, cosmetic).
4. **`MAX_ARROWS = 7000` cap** — verify no visible truncation in any month.
5. **Wind-by-speed colour** for particle mode (alternative to fixed amber).
6. **Anomaly mode UX** — show which months contributed when not all 12 are cached.

### Medium

7. **Validate Lorenz cycle numerics against published values** — Peixoto–Oort 1992 give annual P_M ≈ 4 MJ/m², C(P_M,P_E) ≈ 2 W/m². Spot-check after the Lorenz-sorted reference state is in active use.
8. **Validate budget signs and magnitudes** for Q-budget and H-budget once you've used them in lecture — Newell-Kidson-Vincent-Boer (1972) and Trenberth atlases are the comparison sources.
9. **Add 1981–2010 climatology** — the WMO previous-standard normal. Same recipe as 1961–1990.

### Bigger lift — Phase-4 daily-data unlock

These five all share one data pipeline:

10. **Storm-track diagnostics** — 2–8-day bandpass variance of z500 / v850
11. **Transient-eddy EP flux** — adds time-covariance terms to current stationary diagnostic
12. **Transient-eddy Lorenz cycle** — same idea
13. **Transient-eddy M-budget** — turns stationary → full Newell-Kidson form
14. **ENSO / NAO / SAM / MJO composites** — daily ERA5 regression / composite maps

#### Daily-ERA5 acquisition plan (sketch)

- **Download:** daily means of `u, v, w, t, z, q` at the 12 standard pressure levels for 1991–2020 via CDS (`reanalysis-era5-pressure-levels` daily). ~50–80 GB raw NetCDF.
- **Pipeline:** new `pipeline/build_transient_tiles.py` that computes per-month transient covariances `[u'v']`, `[v'T']`, `[u'ω']`, `[T'²]`, `[u'²+v'²]` from daily samples, then climatologizes across 30 years. ~10–12 GB of derived tiles.
- **Frontend:** add a `Stationary | Stationary + transient | Transient only` toggle on every diagnostic currently labelled "stationary only" (EP flux, Lorenz, M-budget, Q-budget, H-budget).
- **Effort:** one CDS download pass + one pipeline session + ~half a session of frontend wiring per diagnostic.

---

## Phase-4 / horizon

- **Budget viewers** — pick a latitude band or region, show numerical budget closure
- **Guided tours** — authored sequences animating the globe with narrative
- **CMIP6 overlay** — same renderer driven by CMIP historical / SSP climatology
- **Paleoclimate overlay** — PMIP LGM / mid-Holocene
- **Observations overlay** — GPCP, CERES, OISST, ASCAT vs reanalysis

---

## Resume recipe

```bash
cd /Users/mfischer/github/Gen_Circ
git pull
source .venv/bin/activate

# Serve the app (new terminal):
python3 -m http.server 8000
# Open: http://localhost:8000/globe.html
```

**Right now (2026-04-19), the most pressing thing:** finish the 1961–1990 build + GCS push:
```bash
python pipeline/build_tiles.py --period 1961-1990 --group single_levels      # ~5 min
python pipeline/build_tiles.py --period 1961-1990 --group pressure_levels    # ~1 hour
python pipeline/build_helmholtz.py --period 1961-1990                        # ~15 min
gcloud storage cp -r data/tiles_1961_1990 gs://gc-atlas-era5/ \
  --cache-control="public,max-age=31536000,immutable"
```

Re-upload tiles to GCS (after a tile rebuild for default period):
```bash
gcloud storage rsync --recursive data/tiles gs://gc-atlas-era5/tiles
```
