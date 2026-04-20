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

### Two-period comparison — richer modes (Δσ + swipe shipped 2026-04-19)

The Mean+Total swipe-compare landed in v1; remaining variants:

- **B. Stacked side-by-side** in Map view — period A on top half, period B on
  bottom half, both planes painted with a shared range. ~2.5 hours.
  Better for "scan the same latitude band on both panels at once" demos
  vs. the swipe's "fade between" interaction.
- **C. Full dual-globe** in Globe view — two synced rotating spheres,
  shared OrbitControls, two cameras / scenes / textures. Major refactor
  (~half day to a day) since the renderer is currently single-everything.
  Marquee demo but the engineering risk is real (parcels, particles,
  cross-section, hover all need dual-aware paths).
- **Per-mode swipe** — let Compare work in Eddy/Anomaly/Zonal modes too,
  with each side computing its own decomposition reference (e.g. self-eddy
  per period). Currently the v1 swipe restricts to Mean+Total to keep the
  comparison apples-to-apples.

### 0.5° tile resolution — playbook (revisit when ready)

Currently every tile is **1°** (181×360 = 65k cells). Doubling to **0.5°** (361×720 = 261k cells) would sharpen jets, fronts, the Andes/Tibet temperature gradient, and tropical convection without re-downloading anything (CDS NetCDFs are already at 0.5° per `configs/era5_variables.yaml`). This section is the full rollout plan.

**Storage / cost estimates** (us-east1 GCS Standard, late-2025 rates):

| | 1° (now) | 0.5° |
|---|---|---|
| Per-year tree (1991→2026, f16+gz) | 7.7 GB | ~30 GB |
| 1991–2020 climatology | 1.3 GB | ~5 GB |
| 1961–1990 climatology | 1.0 GB | ~4 GB |
| **Total** | **~10 GB** | **~40 GB** |
| Storage cost | $0.20/mo | **$0.80/mo** |
| Egress per session | ~1 MB | ~5 MB |
| All-in @ 1k sessions/mo | <$2 | **~$1.40** |
| All-in @ 10k sessions/mo | <$5 | **~$7** |

**Pipeline rebuild** (~30–50 min wall-clock total, no re-download):

```bash
# All three steps re-run with --resolution 0.5
python pipeline/build_tiles.py     --per-year --resolution 0.5
python pipeline/build_helmholtz.py --per-year --resolution 0.5
python pipeline/compress_tiles.py  --root data/tiles_per_year   # f16+gz pass
# Same for the climatology + 1961-1990 trees if you want them sharpened too:
python pipeline/build_tiles.py     --resolution 0.5
python pipeline/build_tiles.py     --resolution 0.5 --period 1961-1990
python pipeline/build_helmholtz.py --resolution 0.5
python pipeline/build_helmholtz.py --resolution 0.5 --period 1961-1990
python pipeline/compress_tiles.py  --root data/tiles
python pipeline/compress_tiles.py  --root data/tiles_1961_1990
```

**Frontend changes** (the real engineering — ~half a day):

The renderer hard-codes `GRID = { nlat: 181, nlon: 360 }` (data.js) and that constant flows through every diagnostic, decomposition helper, particle field, contour shader, hover-sample logic, etc. To support 0.5° we need one of:

- **Option A (cleanest, more work):** make `GRID` dynamic per-tile, sourced from the manifest's `shape: [nlat, nlon]`. Touches ~15 files. Allows mixed 1°/0.5° trees served from the same site.
- **Option B (pragmatic):** add a global "high-detail mode" toggle that swaps the tile root and the `GRID` constant atomically. All tiles in a session are uniformly 1° or uniformly 0.5°. ~3 hours, low risk.
- **Option C (incremental):** ship 0.5° only in Map view at high zoom; Globe + Orbit stay 1°. Map-view code path reads its own GRID from the active manifest. ~half day, intermediate complexity.

**Recommendation:** Option B for v1 (a "Sharper detail" toggle in the Climatology section), Option A as a Phase-2 cleanup if 0.5° gets popular usage.

**Performance considerations at 0.5°:**

- **Texture upload:** 720×361 RGBA = ~1.04 MB per repaint vs 360×181 = ~260 kB. Modern GPUs handle 4× upload size fine; budget ~5 ms per `texture.needsUpdate`.
- **Particle / contour shaders:** sampling cost scales with output pixels (canvas), not tile resolution — no change.
- **Cross-section + zonal-mean computation:** O(nlat × nlon) work per panel update → 4× longer. Currently ~10 ms; would be ~40 ms. Still imperceptible.
- **Decomposition helpers:** zonalMean / decompose loops scale 4×. Currently sub-ms; would be a few ms. Fine.
- **Hover bilinear sample:** O(1), unchanged.

**Risks / gotchas:**

1. The `applyClampToEntry` percentile-bounds compute in `data.js` does an in-place sort of a length-N array per derived tile. At 4× N (260k vs 65k cells) the sort is ~5× slower (n log n). Still <50 ms, but could feel sluggish during MSE/wspd month-scrubs. Easy fix: switch to a quickselect or histogram-based percentile if it bites.
2. The `aggregatedDecompositionRange` function pools across cached months; with 4× cells per tile, each month iteration does 4× work. Same 5× rule of thumb — measure before optimizing.
3. Reference geojson coastlines (`ne_50m_coastline`, `ne_50m_lakes`) stay at the same density. They'd visibly under-resolve relative to a 0.5° heatmap; consider pulling `ne_10m` for the high-detail mode (~5 MB extra on GCS).
4. Wind particle density (`PARTICLE_COUNT` in particles.js) is currently tuned for 1° smoothness. At 0.5° the particles look sparse for the sharper field — consider doubling.

**Pre-flight checklist when picking this up:**

- [ ] Decide A vs B vs C (recommend B unless dual-resolution serving is needed)
- [ ] Smoke-test 0.5° pipeline on one var (`--var sst --group single_levels`) before churning the full tree
- [ ] Verify GCS bucket has enough quota / no per-prefix limits at 30 GB
- [ ] Update `ne_50m` references to `ne_10m` if going for visual consistency
- [ ] Bump particle count + maybe contour-label density for the high-detail view
- [ ] Re-validate diagnostics that are sensitive to grid spacing (ψ, EP-flux, M-budget) at 0.5° — the spectral/finite-diff numerics should be cleaner, but spot-check Hadley cell strength against published values

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
