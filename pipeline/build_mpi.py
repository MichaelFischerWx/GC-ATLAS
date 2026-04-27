"""Compute Bister-Emanuel Maximum Potential Intensity (MPI) tiles.

Wraps `tcpyPI` (Daniel Gilford's vectorized BE-2002 implementation) over
the ERA5 monthly fields already in data/raw/ + sidecars added by
add_pressure_levels.py. Emits MPI as a new `single_levels` variable so
it slots into the climatology globe's Field dropdown alongside SST, MSL,
etc. The frontend needs no changes — it reads the variable list from
manifest.json at boot.

Inputs per grid cell + month:
    SST   (K)            sea_surface_temperature        single_levels
    MSL   (Pa → hPa)     mean_sea_level_pressure        single_levels
    p     (hPa)          pressure level coordinate      14 levels
    T     (K)            temperature profile            pressure_levels
    q     (kg/kg → g/kg) specific humidity profile      pressure_levels

Outputs per grid cell + month:
    VMAX  (m s-1)   maximum potential intensity → tiles/single_levels/mpi/
    PMIN  (hPa)     minimum central pressure    → tiles/single_levels/pmin/
                                                  (separate var; optional)

Three modes mirror build_tiles.py / add_pressure_levels.py:
    --period 1991-2020 (default)        climatology tree → data/tiles/
    --period 1961-1990                  alternate climo  → data/tiles_1961_1990/
    --per-year                          per-year tree    → data/tiles_per_year/

Usage:
    pip install tcpypi                                                  # one-time
    python pipeline/build_mpi.py                                         # 1991-2020 clim
    python pipeline/build_mpi.py --per-year                              # full per-year tree
    python pipeline/build_mpi.py --period 1961-1990                      # alt climatology
    python pipeline/build_mpi.py --pmin                                  # also write PMIN
    python pipeline/build_mpi.py --resolution 0.5                        # native (slow)
"""
from __future__ import annotations

import argparse
import gzip
import json
import logging
import re
import sys
import time
from pathlib import Path

import numpy as np
import xarray as xr
import yaml

LOG = logging.getLogger("gc-atlas.build_mpi")
ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "configs" / "era5_variables.yaml"
SRC_RES = 0.5

_RAW_DIR_SPAN_RE = re.compile(r'^raw_(\d{4})_(\d{4})$')


def _rename_time(ds: xr.Dataset) -> xr.Dataset:
    if "valid_time" in ds.coords and "time" not in ds.coords:
        ds = ds.rename({"valid_time": "time"})
    return ds


def _downsample(da: xr.DataArray, res: float) -> xr.DataArray:
    lat_name = "latitude" if "latitude" in da.dims else "lat"
    lon_name = "longitude" if "longitude" in da.dims else "lon"
    step = max(1, int(round(res / SRC_RES)))
    if step > 1:
        da = da.isel({lat_name: slice(None, None, step),
                      lon_name: slice(None, None, step)})
    return da


def _open_var_merged(short: str, group: str, raw_dirs: list[Path],
                     period_range: tuple[int, int] | None) -> xr.DataArray:
    """Open era5_<group>_<short>.nc + any matching sidecar (`__add_*`) across
    every raw dir, merging along time AND pressure_level.

    Per-dir we concat main (12 levels) + sidecar (2 levels) along
    `pressure_level` and sortby — a flat `xr.open_mfdataset(..., combine='by_coords')`
    over both files at once produces a non-monotonic level coord
    ([10, 50, …, 1000, 400, 600]) which xarray rejects, so we have to
    interleave manually. Across raw dirs we then concat along `time` to
    span 1961-2026 (or whatever the user has)."""
    def _open_single(p: Path) -> xr.DataArray:
        ds = _rename_time(xr.open_dataset(p))
        v = short if short in ds.data_vars else list(ds.data_vars)[0]
        return ds[v]

    per_dir: list[xr.DataArray] = []
    for d in raw_dirs:
        main_path = d / f"era5_{group}_{short}.nc"
        if not main_path.exists():
            continue
        main_da = _open_single(main_path)

        sidecar_paths = sorted(d.glob(f"era5_{group}_{short}__add_*.nc"))
        if sidecar_paths and "pressure_level" in main_da.dims:
            side_arrays = [_open_single(sp) for sp in sidecar_paths]
            side_da = (side_arrays[0] if len(side_arrays) == 1
                       else xr.concat(side_arrays, dim="pressure_level")
                              .sortby("pressure_level"))
            merged = xr.concat([main_da, side_da], dim="pressure_level") \
                       .sortby("pressure_level")
        else:
            merged = main_da
        per_dir.append(merged)

    if not per_dir:
        raise FileNotFoundError(f"no NetCDFs found for {group}/{short} in {raw_dirs}")

    if len(per_dir) == 1:
        da = per_dir[0]
    else:
        da = xr.concat(per_dir, dim="time").sortby("time")

    if period_range is not None and "time" in da.dims:
        s, e = period_range
        da = da.sel(time=slice(f"{s}-01-01", f"{e}-12-31"))
    return da


# ── tcpyPI invocation ─────────────────────────────────────────
def _run_pi_vectorized(sst_k, msl_hpa, p_hpa_da, t_k, q_kgkg, lev_dim: str):
    """Vectorize tcpyPI.pi over (time, lat, lon) via xr.apply_ufunc.

    `tcpyPI.pi` is numba-jitted and only accepts scalar SST/MSL + 1D
    profiles per call — it can't be handed 3D arrays. apply_ufunc
    with `vectorize=True` does a per-grid-cell Python loop. Slow
    (~20-60 min for a 65-yr × 12-mo × 1° grid) but a one-time job.

    Inputs are xarray DataArrays:
      sst_k:    (time, lat, lon)             Kelvin
      msl_hpa:  (time, lat, lon)             hPa
      p_hpa_da: (level,)                     hPa pressure coord
      t_k:      (time, level, lat, lon)      Kelvin
      q_kgkg:   (time, level, lat, lon)      kg/kg specific humidity

    Returns (vmax, pmin) DataArrays in (time, lat, lon), masked on the
    convergence flag (NaN where pi() failed to converge / over land).
    """
    from tcpyPI import pi as bepi

    sst_c = sst_k - 273.15
    t_c   = t_k   - 273.15
    # tcpyPI wants mixing ratio (g/kg), not specific humidity (kg/kg).
    # r = q / (1 - q); for q << 1 the difference is negligible but the
    # tcpyPI doc requires this conversion.
    r_gkg = (q_kgkg / np.clip(1 - q_kgkg, 1e-12, None)) * 1000.0

    vmax, pmin, ifl, t0, otl = xr.apply_ufunc(
        bepi,
        sst_c, msl_hpa, p_hpa_da, t_c, r_gkg,
        input_core_dims=[[], [], [lev_dim], [lev_dim], [lev_dim]],
        output_core_dims=[[], [], [], [], []],
        kwargs=dict(CKCD=0.9, ascent_flag=0, diss_flag=1,
                    V_reduc=0.8, ptop=50, miss_handle=1),
        vectorize=True,
        output_dtypes=[float, float, float, float, float],
    )
    # ifl == 1 means converged + valid. Land / non-convergent cells get NaN.
    vmax = vmax.where(ifl == 1)
    pmin = pmin.where(ifl == 1)
    return vmax, pmin


def _ensure_axis_order(t_da: xr.DataArray, q_da: xr.DataArray):
    """Reorder to (time, level, lat, lon)."""
    lev = "pressure_level" if "pressure_level" in t_da.dims else "level"
    lat = "latitude" if "latitude" in t_da.dims else "lat"
    lon = "longitude" if "longitude" in t_da.dims else "lon"
    t_da = t_da.transpose("time", lev, lat, lon)
    q_da = q_da.transpose("time", lev, lat, lon)
    return t_da, q_da, lev, lat, lon


# ── Tile writers ──────────────────────────────────────────────
def _write_clim_tiles(arr_by_month: dict[int, np.ndarray], out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    for m, arr in arr_by_month.items():
        (out_dir / f"{m:02d}.bin").write_bytes(arr.astype("<f4").tobytes())


def _write_peryear_tiles(da: xr.DataArray, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    for ti in range(da.sizes["time"]):
        y = int(da.time.dt.year[ti].item())
        m = int(da.time.dt.month[ti].item())
        arr = da.isel(time=ti).values.astype("<f4")
        (out_dir / f"{y}_{m:02d}.bin").write_bytes(arr.tobytes())


def _scan_minmax(var_dir: Path) -> tuple[float, float]:
    vmin, vmax = np.inf, -np.inf
    for tile in var_dir.iterdir():
        if not tile.name.endswith((".bin", ".bin.gz")):
            continue
        if tile.name.endswith(".bin.gz"):
            with gzip.open(tile, "rb") as f:
                buf = f.read()
        else:
            buf = tile.read_bytes()
        arr = np.frombuffer(buf, dtype="<f4")
        finite = arr[np.isfinite(arr)]
        if finite.size:
            vmin = min(vmin, float(finite.min()))
            vmax = max(vmax, float(finite.max()))
    return vmin, vmax


def _write_meta(out_dir: Path, short: str, long_name: str, units: str,
                lat_vals, lon_vals, has_std: bool, per_year: bool,
                years: list[int] | None = None,
                year_months: list[tuple[int, int]] | None = None,
                source_dirs: list[str] | None = None) -> None:
    vmin, vmax = _scan_minmax(out_dir)
    meta = {
        "var": short,
        "group": "single_levels",
        "long_name": long_name,
        "units": units,
        "shape": [len(lat_vals), len(lon_vals)],
        "lat_descending": bool(lat_vals[0] > lat_vals[-1]),
        "lat_first": float(lat_vals[0]),
        "lat_last":  float(lat_vals[-1]),
        "lon_first": float(lon_vals[0]),
        "lon_last":  float(lon_vals[-1]),
        "vmin": vmin if np.isfinite(vmin) else 0.0,
        "vmax": vmax if np.isfinite(vmax) else 100.0,
        "has_std": has_std,
        "levels":   None,
    }
    if per_year:
        meta["years"] = years or []
        meta["year_months"] = [[y, m] for (y, m) in (year_months or [])]
        if source_dirs:
            meta["source_dirs"] = source_dirs
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))


def _gzip_dir(out_dir: Path) -> None:
    for tile in list(out_dir.iterdir()):
        if not tile.name.endswith(".bin"):
            continue
        gz = tile.with_suffix(".bin.gz")
        with tile.open("rb") as fin, gzip.open(gz, "wb", compresslevel=6) as fout:
            fout.write(fin.read())
        tile.unlink()


def _rewrite_manifest(out_dir: Path) -> None:
    groups: dict = {}
    for group_dir in sorted(out_dir.iterdir()):
        if not group_dir.is_dir():
            continue
        vars_: dict = {}
        for var_dir in sorted(group_dir.iterdir()):
            mp = var_dir / "meta.json"
            if mp.exists():
                vars_[var_dir.name] = json.loads(mp.read_text())
        if vars_:
            groups[group_dir.name] = vars_
    (out_dir / "manifest.json").write_text(json.dumps({"groups": groups}, indent=2))


# ── Main driver ───────────────────────────────────────────────
def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--period", help="START-END (default from era5_variables.yaml)")
    ap.add_argument("--per-year", action="store_true",
                    help="emit per-year MPI tiles into data/tiles_per_year/")
    ap.add_argument("--raw-dirs",
                    help="comma-separated raw dirs to merge. Default: data/raw "
                         "in climatology mode; raw + raw_1961_1990 + raw_2021_2026 "
                         "in per-year mode (mirrors add_pressure_levels.py).")
    ap.add_argument("--resolution", type=float, default=1.0,
                    help="target grid spacing (default 1.0; native is 0.5)")
    ap.add_argument("--pmin", action="store_true",
                    help="also write PMIN (minimum central pressure) as a "
                         "second variable — useful for storm-intensity climatology")
    ap.add_argument("--gzip", action="store_true",
                    help="DEPRECATED: write plain gzipped .bin.gz tiles. "
                         "Default is to write raw .bin and let "
                         "compress_tiles.py do the proper f16-gz "
                         "quantization (matches every other variable).")
    ap.add_argument("--force", action="store_true",
                    help="rebuild even if output exists")
    return ap.parse_args()


def resolve_raw_dirs(args, period: tuple[int, int]) -> list[Path]:
    if args.raw_dirs:
        return [ROOT / d.strip() if not Path(d.strip()).is_absolute() else Path(d.strip())
                for d in args.raw_dirs.split(",") if d.strip()]
    if args.per_year:
        dirs = [ROOT / "data" / "raw"]
        for sib in sorted((ROOT / "data").glob("raw_*")):
            if sib.is_dir():
                dirs.append(sib)
        return dirs
    if period == (1991, 2020):
        return [ROOT / "data" / "raw"]
    return [ROOT / "data" / f"raw_{period[0]}_{period[1]}"]


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()

    cfg = yaml.safe_load(CONFIG_PATH.read_text())
    period = (cfg["period"]["start"], cfg["period"]["end"])
    if args.period:
        period = tuple(int(x) for x in args.period.split("-"))

    raw_dirs = resolve_raw_dirs(args, period)
    period_range = period if not args.per_year else None

    if args.per_year:
        out_dir = ROOT / "data" / "tiles_per_year"
        mode = "per-year"
    elif period == (1991, 2020):
        out_dir = ROOT / "data" / "tiles"
        mode = "climatology"
    else:
        out_dir = ROOT / "data" / f"tiles_{period[0]}_{period[1]}"
        mode = "climatology"

    LOG.info("mode=%s  out=%s  period=%s  res=%.2f°  pmin=%s",
             mode, out_dir.relative_to(ROOT), period, args.resolution, args.pmin)
    for d in raw_dirs:
        LOG.info("  raw dir: %s", d.relative_to(ROOT) if d.is_relative_to(ROOT) else d)

    mpi_dir  = out_dir / "single_levels" / "mpi"
    pmin_dir = out_dir / "single_levels" / "pmin"
    if mpi_dir.exists() and not args.force:
        LOG.error("output exists: %s (use --force to rebuild)", mpi_dir)
        return 2

    LOG.info("open  SST + MSL + T + q across %d raw dir(s) (with sidecars)", len(raw_dirs))
    sst = _open_var_merged("sst", "single_levels", raw_dirs, period_range)
    msl = _open_var_merged("msl", "single_levels", raw_dirs, period_range)
    t   = _open_var_merged("t",   "pressure_levels", raw_dirs, period_range)
    q   = _open_var_merged("q",   "pressure_levels", raw_dirs, period_range)

    sst = _downsample(sst, args.resolution)
    msl = _downsample(msl, args.resolution)
    t   = _downsample(t,   args.resolution)
    q   = _downsample(q,   args.resolution)

    # Align time axes — open_mfdataset across sidecars can introduce gaps.
    common = sst.time.to_index().intersection(msl.time.to_index()) \
                                .intersection(t.time.to_index())   \
                                .intersection(q.time.to_index())
    sst = sst.sel(time=common); msl = msl.sel(time=common)
    t   = t  .sel(time=common); q   = q  .sel(time=common)
    LOG.info("aligned time axis: %d steps", len(common))

    t, q, lev, latn, lonn = _ensure_axis_order(t, q)
    # tcpyPI requires pressure in DESCENDING order (1000 hPa → top of
    # atmosphere) — its docstring claims the opposite, but the algorithm
    # iterates from surface upward and IFL=0 (failure) for ascending input.
    # Reverse t/q along the level dim so they match.
    if t[lev].values[0] < t[lev].values[-1]:
        t = t.sortby(lev, ascending=False)
        q = q.sortby(lev, ascending=False)
    p_hpa = np.asarray(t[lev].values, dtype="float64")
    LOG.info("levels (descending): %s  (n=%d)", list(p_hpa), len(p_hpa))

    # Force-load to memory once. With our default 1° resolution the per-time
    # 4D float32 array is 14 × 181 × 360 × 4 ≈ 3.6 MB, so the full 65-year
    # × 12-month time axis is ~3.4 GB — fine on a laptop with 16 GB RAM but
    # if it's tight, swap the .load() for chunked .compute() per year.
    sst = sst.load(); msl = msl.load()
    t   = t  .load(); q   = q  .load()

    # MSL Pa → hPa
    msl_hpa = msl / 100.0
    msl_hpa = msl_hpa.assign_attrs(units="hPa")

    p_da = xr.DataArray(p_hpa, dims=[lev], coords={lev: t[lev].values})
    LOG.info("compute MPI via xr.apply_ufunc — vectorize=True; "
             "this is the slow step (~20-60 min for 65×12 × 1° grid)")
    t_compute_start = time.time()

    vmax_da, pmin_da = _run_pi_vectorized(sst, msl_hpa, p_da, t, q, lev)
    # Force evaluation now (apply_ufunc returns lazily over xarray's internal
    # broadcasting). Two .compute() calls force the per-cell loop to run.
    vmax_da = vmax_da.astype("float32").rename("mpi")
    vmax_da.attrs.update({
        "long_name": "Maximum potential intensity (Bister-Emanuel)",
        "units": "m s-1",
    })
    pmin_da = pmin_da.astype("float32").rename("pmin")
    pmin_da.attrs.update({
        "long_name": "Minimum central pressure (Bister-Emanuel)",
        "units": "hPa",
    })
    LOG.info("done MPI compute in %.0fs", time.time() - t_compute_start)

    lat_vals = sst[latn].values
    lon_vals = sst[lonn].values

    if args.per_year:
        years = sorted(set(int(t) for t in vmax_da.time.dt.year.values))
        ymonths = sorted({(int(d.dt.year.item()), int(d.dt.month.item())) for d in vmax_da.time})
        source_dirs = [d.name for d in raw_dirs]

        _write_peryear_tiles(vmax_da, mpi_dir)
        _write_meta(mpi_dir, "mpi", "Maximum potential intensity (Bister-Emanuel)",
                    "m s-1", lat_vals, lon_vals, has_std=False, per_year=True,
                    years=years, year_months=ymonths, source_dirs=source_dirs)
        if args.pmin:
            _write_peryear_tiles(pmin_da, pmin_dir)
            _write_meta(pmin_dir, "pmin", "Minimum central pressure (Bister-Emanuel)",
                        "hPa", lat_vals, lon_vals, has_std=False, per_year=True,
                        years=years, year_months=ymonths, source_dirs=source_dirs)
    else:
        # Climatology mean by month-of-year, plus inter-annual std.
        clim_v = vmax_da.groupby("time.month").mean("time", keep_attrs=True)
        std_v  = vmax_da.groupby("time.month").std("time", keep_attrs=True)
        _write_clim_tiles({m: clim_v.sel(month=m).values for m in range(1, 13)}, mpi_dir)
        for m in range(1, 13):
            arr = std_v.sel(month=m).values.astype("<f4")
            (mpi_dir / f"std_{m:02d}.bin").write_bytes(arr.tobytes())
        _write_meta(mpi_dir, "mpi", "Maximum potential intensity (Bister-Emanuel)",
                    "m s-1", lat_vals, lon_vals, has_std=True, per_year=False)
        # Patch in std vmin/vmax after _scan_minmax pass.
        meta = json.loads((mpi_dir / "meta.json").read_text())
        std_v_finite = std_v.values[np.isfinite(std_v.values)]
        if std_v_finite.size:
            meta["std_vmin"] = float(std_v_finite.min())
            meta["std_vmax"] = float(std_v_finite.max())
        (mpi_dir / "meta.json").write_text(json.dumps(meta, indent=2))

        if args.pmin:
            clim_p = pmin_da.groupby("time.month").mean("time", keep_attrs=True)
            std_p  = pmin_da.groupby("time.month").std("time", keep_attrs=True)
            _write_clim_tiles({m: clim_p.sel(month=m).values for m in range(1, 13)}, pmin_dir)
            for m in range(1, 13):
                arr = std_p.sel(month=m).values.astype("<f4")
                (pmin_dir / f"std_{m:02d}.bin").write_bytes(arr.tobytes())
            _write_meta(pmin_dir, "pmin", "Minimum central pressure (Bister-Emanuel)",
                        "hPa", lat_vals, lon_vals, has_std=True, per_year=False)
            meta = json.loads((pmin_dir / "meta.json").read_text())
            std_p_finite = std_p.values[np.isfinite(std_p.values)]
            if std_p_finite.size:
                meta["std_vmin"] = float(std_p_finite.min())
                meta["std_vmax"] = float(std_p_finite.max())
            (pmin_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    if args.gzip:
        # Legacy path; produces .bin.gz of raw float32 (NOT f16 quantized).
        # The frontend will 404 these unless meta.encoding is set, so the
        # canonical workflow is to leave .bin and run compress_tiles.py.
        _gzip_dir(mpi_dir)
        if args.pmin:
            _gzip_dir(pmin_dir)
    else:
        LOG.info("tiles left as .bin — run `python pipeline/compress_tiles.py "
                 "--root %s --var mpi --group single_levels` to f16-gz them "
                 "(also adds meta.encoding so era5.js finds the .bin.gz files).",
                 out_dir.relative_to(ROOT))

    _rewrite_manifest(out_dir)
    LOG.info("DONE  total elapsed %.0fs", time.time() - t_compute_start)
    return 0


if __name__ == "__main__":
    sys.exit(main())
