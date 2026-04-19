# GC-ATLAS — Roadmap

Last update: 2026-04-18 (added q/r/d/vo fields, MSE, N² + EP-flux + Lorenz cycle diagnostics)

## Where we are

**Live locally** via `python -m http.server 8000` → `http://localhost:8000/globe.html`.
**Public site** on GitHub Pages: https://michaelfischerwx.github.io/GC-ATLAS/ — tiles served from `gs://gc-atlas-era5` (us-east1, public read).
GA4 wired (G-M1M3TNNJCB) on landing + globe pages.

**Data on disk:**
- `data/raw/` — all 26 ERA5 monthly-mean NetCDFs (1991–2020), ~20 GB. Gitignored.
- `data/tiles/` — per-(var, level, month) Float32 binaries at 1° + `manifest.json`, ~228 MB. Gitignored, mirrored on GCS.

---

## What's shipped

### Views (three modes)
- **Globe** (Three.js, OrbitControls, axial tilt)
- **Map** (equirectangular, drag-to-pan, central-meridian slider)
- **Orbit** ("viewer from space," Level 3) — heliocentric scene with sun sprite + halo, dashed ecliptic ring, orbit-direction arrow, solstice/equinox markers, mini-Earth, day/night terminator, latitude reference circles, subsolar marker, amber axis, cosmetic diurnal spin

### Fields
- **Pressure-level (9):** `t, u, v, w, z, q, r, vo, d` on `[10, 50, 100, 150, 200, 250, 300, 500, 700, 850, 925, 1000]` hPa
- **Single-level (16):** `msl, sp, t2m, d2m, sst, tcwv, tp, blh, sshf, slhf, ssr, str, tisr, ttr` …
- **Derived:** wind speed `wspd = √(u² + v²)`, Ertel PV on isentropes, **moist static energy** `MSE = c_p·T + g·z + L_v·q` (displayed as MSE/c_p in K)
- All ERA5 unit conversions applied at load: `z` (m²/s² → m), `msl/sp` (Pa → hPa), `tp` (m/day → mm/day), radiative fluxes (J/m²/day → W/m²), `q` (kg/kg → g/kg), `vo, d` (s⁻¹ → 10⁻⁵ s⁻¹)

### Vertical coordinate toggle
- **Pressure** (12 hPa levels) or **θ (isentropic)** on `[280, 300, 315, 330, 350, 400, 500, 700]` K
- Per-column linear interpolation of pressure-level tiles to θ₀
- PV is θ-only (forces θ mode when selected)
- Loading overlay while ~24 tiles land for an isentropic surface

### Decomposition (Total / Zonal / Eddy / Anomaly)
- Client-side per render pass on the cached tile
- Eddy & Anomaly auto-switch to symmetric range / divergent colormap
- Anomaly uses an annual mean built from whatever months are cached

### Wind overlays
- **Off / Particles / Barbs**
- Particles: 12 k GPU-lit, per-particle lifetime jitter, fade-in/out, head dots, screen-space wrap on map seam, prefetched u/v at every level for θ mode
- Barbs: WMO-standard at every 8°, NH-convention feather side

### Cross-section panel
- **Zonal-mean by default**, or **click-drag (Shift+drag) great-circle arc** anywhere on the globe
- Variable selector: **Field section / ψ mass streamfunction / M angular momentum / N² Brunt–Väisälä / EP flux (stationary eddy)**
- EP flux mode overlays Edmon–Hoskins–McIntyre arrows on a ∇·F shading (m s⁻¹ day⁻¹)
- Own colorbar, gridlines, contours, midpoint marker, reset button

### Other diagnostics
- **Lagrangian parcels** (Alt+click globe) — RK2 on monthly-mean (u, v, ω), trilinear in (lat, lon, log-p), trails + head dots, max 30-day lifetime, radius encodes pressure
- **Hover readout** — floating (lat, lon, value) tooltip via raycast (globe + map)
- **Contour overlay** (anti-aliased GLSL, fwidth-based AA, emphasised v=0 for divergent fields). Always uses the raw field (not the decomposed one).
- **Lorenz energy cycle panel (stationary eddies)** — global mass-weighted P_M, P_E, K_M, K_E plus four conversions, computed from monthly-mean u/v/w/t. SVG 4-box schematic with live values; arrow widths encode |C|. Reservoirs in MJ/m², conversions in W/m². Reference state toggle: **Lorenz (sorted)** — adiabatic mass-resorting, Lorenz 1955 original — or **Area-mean** — simpler approximation. Leading factor R/(2g) reproduces Peixoto–Oort 1992 P_M ≈ 4 MJ/m².

### Sharing
- **GIF export** — animated (5 s loop, current month) or annual cycle (12 frames). gifenc-based, palette-quantised.

### Polish
- Coastlines (Natural Earth 1:50 m) + graticule + sun/terminator toggles
- Aggregated colorbar across all cached months for a (field, level)
- NaN-as-no-data render for pending tiles
- Tips panel; mobile drawer / hamburger

---

## Next steps

### Small polish (can do anytime)

1. **Dark coastline on dark colormap fallback** — black coastlines vanish over viridis purple. Auto-switch to white (or half-tone) when colormap is dark.
2. **Bundle `ne_50m_coastline.geojson` locally** instead of fetching from jsdelivr on every page load (~2 MB). Push it through GCS or commit to the repo.
3. **Favicon** (still 404, cosmetic).
4. **`MAX_ARROWS = 7000` cap** — verify it doesn't truncate visibly in any month. Bump or make adaptive if so.

### Medium (one focused session each)

5. **Geostrophic wind from z** as a cross-section diagnostic.
6. **Wind-by-speed colour** option for particle mode (alternative to fixed amber).
7. **Anomaly mode UX** — show which months contributed when not all 12 are cached.
8. **Validate Lorenz cycle numerics against published values** — Peixoto & Oort 1992 give annual-mean magnitudes (P_M ~50 MJ/m², C(P_M,P_E) ~2 W/m², etc.). Spot-check against those once tiles are pushed.
9. **Explicit torques in the M-budget panel** — the "implied torque" we currently show is the residual of computed transport terms; it confounds true surface torque + missing transient eddies + numerical noise. Add two ERA5 fields and compute each torque directly:
   - **Friction torque**: download `ews` (eastward turbulent surface stress, ~12 MB after tiling, single-level monthly mean). Friction torque profile: τ_f(φ) = -⟨[ews]⟩ (negative because positive stress on air = sink of atmospheric M to the surface).
   - **Mountain torque**: download invariant `z` at surface (orography, ~3 MB) once; combine with our existing `sp` tile to compute τ_m(φ) = ⟨[p_s · ∂h/∂λ]⟩ as a latitude profile.
   - Display: in the lat-only view, overlay friction + mountain alongside the "implied torque" line. Their sum should approximately equal the implied torque (any gap is the missing transient-eddy convergence — direct visual evidence of the stationary-only limitation).

### Bigger lifts

8. **Multiple base periods** — pre-bake 1961-1990 / 1981-2010 / 1991-2020 climatologies on separate GCS path prefixes. Pair with Anomaly decomposition to expose the climate-change signal as a period-to-period difference. ~3× tile storage (≈ 700 MB), ~20 lines of frontend. Decide which periods after teaching with current version.
9. **Variability envelopes ±1σ** across years — needs re-processing from raw data (group-std alongside group-mean in `pipeline/build_climatology.py`).

### Needs new data

10. **Storm-track diagnostics** — 2–8-day bandpass variance of z500 / v850. Requires daily ERA5.
11. **Transient-eddy EP flux** — adds the time-covariance terms to the existing stationary-eddy diagnostic. Requires daily ERA5.
12. **Transient-eddy Lorenz cycle** — same story; the stationary version ships from monthly means, transient needs daily.
13. **Transient-eddy angular momentum budget** — turns the existing stationary M-budget into the full P&O Fig 11.7 / Newell-Kidson budget. Requires daily ERA5 covariances.
14. **ENSO / NAO / SAM / MJO composites** — daily ERA5 regression / composite maps.

#### Daily-ERA5 acquisition plan (sketch)

These five items all share the same data path. Estimated work to enable:
- **Download:** daily means of `u, v, w, t, z, q` at the 12 standard pressure levels for 1991–2020 via CDS (`reanalysis-era5-pressure-levels` daily). ~50–80 GB raw NetCDF.
- **Pipeline:** new `pipeline/build_transient_tiles.py` that, per-month, computes zonal-mean transient covariances `[u'v']`, `[v'T']`, `[u'ω']`, `[T'²]`, `[u'²+v'²]` from daily samples (with `'` denoting departure from the *monthly mean*), then climatologizes across 30 years. ~10–12 GB of derived covariance tiles.
- **Frontend:** add a `Stationary | Stationary + transient | Transient only` toggle on every diagnostic that currently says "stationary only" (EP flux, Lorenz, M-budget). Total + transient paths just sum the new tiles into the existing computations.
- **Effort:** ~one focused download pass (CDS queue can take ~hours-days), one pipeline session, ~half a session of frontend wiring per diagnostic.

This is the natural Phase-4 unlock — turns three existing diagnostics from "planetary-wave only" into the canonical full-cycle diagnostics.

---

## Phase-4 / horizon

- **Budget viewers** — pick a latitude band or region, show closed energy / moisture / angular-momentum budgets as numbers + schematic.
- **Guided tours** — authored sequences that animate the globe and toggle fields while text narrates. Useful for pre-lecture assignments.
- **CMIP6 overlay** — same renderer driven by CMIP historical / SSP climatology. Anomaly mode reveals climate-change signal in every field.
- **Paleoclimate overlay** — PMIP LGM / mid-Holocene runs for a "how different was the circulation?" unit.
- **Observations overlay** — GPCP, CERES, OISST, ASCAT — to contrast reanalysis with obs.

---

## Resume recipe

```bash
cd /Users/mfischer/github/Gen_Circ
git pull
source .venv/bin/activate

# Serve the app (new terminal):
python3 -m http.server 8000

# Open:
# http://localhost:8000/globe.html
```

Re-upload tiles to GCS (after a tile rebuild):
```bash
gcloud storage cp -r data/tiles/* gs://gc-atlas-era5/tiles/ \
  --cache-control="public,max-age=31536000,immutable"
```

Rebuild tiles (resolution change, new field, fix to `build_tiles.py`):
```bash
python pipeline/build_tiles.py --group pressure_levels --force
python pipeline/build_tiles.py --group single_levels --force
```
