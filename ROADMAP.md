# GC-ATLAS — Roadmap

Last update: 2026-04-18

## Where we are

**Live locally** via `python -m http.server 8000` → `http://localhost:8000/globe.html`.
**GitHub Pages** serves the code only (no tiles): https://michaelfischerwx.github.io/GC-ATLAS/.

**Data on disk:**
- `data/raw/` — all 26 ERA5 monthly-mean NetCDFs (1991–2020), ~20 GB. Gitignored.
- `data/tiles/` — per-(var, level, month) Float32 binaries at 1° + `manifest.json`, ~228 MB. Gitignored.

**What works end-to-end (on localhost):**
- 3D globe (Three.js) + 2D equirectangular map toggle
- Spinnable/zoomable with OrbitControls; axial tilt in globe mode
- 10 pressure-level + 16 single-level ERA5 fields plus 1 derived (wind speed)
- Synthetic fallback for any field whose tile isn't cached
- 12-month climatology, month slider + play button, aggregated colorbar across months
- Cross-section panel (zonal mean on log-pressure axis)
- Coastlines (Natural Earth 1:50 m, black @ 0.88) and graticule (white @ 0.55, amber equator)
- Wind overlay modes: Off / Particles (12 k GPU-lit, nullschool-ish) / Streamlines (1.6 k, Line2 polylines, directional arrow glyphs along each)
- Proper unit conversions: geopotential (m² s⁻² → m), pressure (Pa → hPa), precip (m day⁻¹ → mm day⁻¹), radiative fluxes (J m⁻² day⁻¹ → W m⁻²)

---

## Immediate next steps

### 1. ~~Host tiles on GCS~~ ✓ (2026-04-18)
Bucket: `gs://gc-atlas-era5` in project `tc-atlas-web`, region `us-east1`.
- Public read (`allUsers:objectViewer`), CORS for `https://michaelfischerwx.github.io` + `http://localhost:8000`.
- 934 tiles / 227 MB uploaded with `cache-control: public,max-age=31536000,immutable`.
- `js/era5.js` `TILE_BASE` switches to `https://storage.googleapis.com/gc-atlas-era5/tiles` on any non-localhost host.
- Re-upload recipe: `gcloud storage cp -r data/tiles/* gs://gc-atlas-era5/tiles/ --cache-control="public,max-age=31536000,immutable"`.

### 2. ~~Verify precipitation & radiative-flux unit conversions~~ ✓ (2026-04-18)
Spot-checked `tp`, `ssr`, `str`, `slhf`, `tisr` across months against known global references.
- `tp` Dec max 63.7 mm/day, tropics 2–14 mm/day, polar near-zero ✓
- `ssr` Jul global mean 129 W/m² (ref ≈ 161 ann), max 315 ✓
- `str` Jul net LW loss at surface, range −174…−1 W/m² ✓
- `slhf` Jul evap peaking over subtropical oceans at −350 W/m² ✓
- `tisr` Dec subtropical peak 544 W/m² ✓ (small raw file is just good compression on a smooth field)

### 3. ~~Orbit mode ("viewer from space", Level 3)~~ ✓ (2026-04-18)
Third view added with heliocentric scene: sun sprite + additive halo at origin, dashed ecliptic ring, orbit-direction arrow, solstice/equinox dot+label markers, minor month ticks, mini-Earth with fixed axial tilt, day/night terminator, latitude reference circles (equator, tropics, polar circles), subsolar-point marker, amber axis line, cosmetic diurnal spin.

### 4. Decomposition toggles (high pedagogical value, low effort)
Radio group: `Total | Zonal-mean | Eddy | Anomaly`.
- Zonal-mean: subtract longitude mean → 1D lat × level.
- Eddy: values − zonal_mean → reveals stationary waves instantly.
- Anomaly: values − 12-month mean → seasonal cycle removed.
- All doable client-side from the cached tile; just a per-rendering pass.

---

## Phase-3 features (next-session candidates)

- **Wind barbs overlay** — third mode in the Wind segmented control. Glyph per coarse grid cell (every ~8°); feathers = 10 kt, flags = 50 kt; oriented in the local tangent plane. More work than streamlines (needs custom glyph geometry per orientation) but completes the windy.com trio.
- **Click-to-draw cross-section** — drag a great-circle arc on the globe; panel shows vertical cross-section along that arc (not just zonal). Requires projecting screen-space click to (lat, lon) and sampling the field at all 12 levels along a parametrised path.
- **Hover readout** — show lat / lon / field value under cursor. Needs raycasting against the sphere/plane and bilinear sampling of the current tile.
- **Dark coastline on dark colormap fallback** — black coastlines disappear over viridis purple. Auto-switch to white (or half-tone) when the colormap is dark.
- **Derived 3-D diagnostics** (require either pipeline support or on-the-fly):
  - Mass streamfunction ψ(φ, p) from v and ω
  - Brunt–Väisälä N² from T
  - Geostrophic wind from z
  - PV on isentropes (need vorticity — `vo` is already in `data/tiles/`)
  - Horizontal divergence (`d` is already in `data/tiles/`)
  - Wind-speed colour could be replaced with a "winds by speed" optional colour mode for particles.
- **Storm-track diagnostics** — need daily ERA5, not monthly. Separate download pass. 2–8-day bandpass variance of z500 / v850.
- **EP flux vectors** on the zonal-mean cross-section — also needs daily data for transient eddy terms.

---

## Phase-4 / horizon

- **Lagrangian parcel mode** — seed N parcels, advect on the 3-D climatological wind (u, v, ω). Visualises overturning in real time. The original "big dream" pitch.
- **Budget viewers** — pick a latitude band or region, get closed energy / moisture / angular-momentum budgets as numbers + schematic.
- **Variability envelopes** — ±1σ across years. Needs re-processing from raw data (group-std in addition to group-mean).
- **ENSO / NAO / SAM / MJO composites** — daily ERA5 regression / composite maps.
- **Guided tours** — authored sequences that animate the globe and toggle fields while text narrates. Useful for pre-lecture assignments.
- **CMIP6 overlay** — same renderer driven by CMIP historical / SSP climatology. Anomaly mode reveals climate-change signal in every field.
- **Paleoclimate overlay** — PMIP LGM / mid-Holocene runs for a "how different was the circulation?" unit.
- **Observations overlay** — GPCP, CERES, OISST, ASCAT — to contrast reanalysis with obs.

---

## Known issues / polish

- Favicon 404 (harmless, cosmetic).
- ~~Synthetic placeholders are stale~~ — retired 2026-04-18; pending-tile render is now a NaN-fill that paints as the colormap's "no-data" colour.
- ~~`tisr` raw file unusually small~~ — verified 2026-04-18; climatology is correct, the small raw file is just compression on a smooth zonal-only field.
- Coastlines: `ne_50m_coastline.geojson` fetched at runtime from jsdelivr on every page load (~2 MB). Consider bundling as a local file or pushing through GCS.
- `MAX_ARROWS = 7000` may cap out for some high-wind months; safe but worth monitoring.

---

## Resume recipe (next session)

```bash
cd /Users/mfischer/github/Gen_Circ
git pull
source .venv/bin/activate

# Serve the app (new terminal):
python3 -m http.server 8000

# Open:
# http://localhost:8000/globe.html
```

If tiles need to be rebuilt (resolution change, new field, fix to build_tiles.py):
```bash
python pipeline/build_tiles.py --group pressure_levels --force
python pipeline/build_tiles.py --group single_levels --force
```
