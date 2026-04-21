"""Compute velocity potential χ and streamfunction ψ from ERA5 u, v.

ERA5 monthly_averaged_reanalysis does NOT serve χ and ψ directly (they exist
only in 6-hourly ERA5), so we derive them via Helmholtz decomposition on the
sphere. The decomposition splits the horizontal wind into:

    v_h = -∇χ + k̂ × ∇ψ

where ∇²χ = D (divergence) and ∇²ψ = ζ (vorticity). We solve the two Poisson
equations using spherical harmonic transforms (windspharm wraps pyspharm).

Output: per-(level, month) tiles in data/tiles/pressure_levels/{chi,psi}/,
matching the build_tiles.py format. Also writes meta.json with units and the
optional std-across-years tiles.

Pedagogy:
  • 200 hPa χ shows large-scale rising/sinking centres (negative χ over the
    Maritime Continent rising branch, positive over east-Pacific sinking) —
    the cleanest Walker / ENSO diagnostic.
  • 200 hPa ψ shows the upper-trop circulation skeleton (jet axes, subtropical
    anticyclones, planetary Rossby-wave structure when paired with Eddy mode).

Install (one-time):
    pip install windspharm
    # On macOS, pyspharm needs gfortran. If pip install fails:
    #   brew install gfortran
    #   pip install windspharm

Usage:
    python pipeline/build_helmholtz.py             # compute both, all levels, with std
    python pipeline/build_helmholtz.py --no-std    # skip std (faster)
    python pipeline/build_helmholtz.py --force     # overwrite existing tiles
    python pipeline/build_helmholtz.py --period 1961-1990
    python pipeline/build_helmholtz.py --per-year \\
        --raw-dirs data/raw,data/raw_2021_2026     # per-(year, month) tiles into
                                                    # data/tiles_per_year/
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import numpy as np
import xarray as xr

LOG = logging.getLogger("gc-atlas.helmholtz")
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW_DIR = ROOT / "data" / "raw"
DEFAULT_OUT_DIR = ROOT / "data" / "tiles" / "pressure_levels"
SRC_RES = 0.5    # ERA5 native (CDS download) grid


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--period", help="START-END, e.g. 1961-1990 (writes data/tiles_START_END/). "
                                     "Without --raw-dirs, reads data/raw_START_END/. With --raw-dirs, "
                                     "reads from those dirs + subsets the time axis to [START, END].")
    ap.add_argument("--per-year", action="store_true",
                    help="emit per-(year, month) χ/ψ tiles into data/tiles_per_year/. "
                         "Skips climatology averaging and std; combines with --raw-dirs.")
    ap.add_argument("--raw-dirs",
                    help="comma-separated raw NetCDF dirs to merge along time. "
                         "Per-year mode: union becomes the per-year tree. "
                         "Climatology mode (--period): union is then subset to the period years. "
                         "Default per-year: data/raw + any data/raw_YYYY_YYYY siblings except raw_1961_1990.")
    ap.add_argument("--resolution", type=float, default=1.0,
                    help="target grid spacing in degrees (default 1.0; source is 0.5)")
    ap.add_argument("--no-std", action="store_true", help="skip std-across-years tiles")
    ap.add_argument("--force", action="store_true", help="overwrite existing tiles")
    return ap.parse_args()


def _rename_time(ds: xr.Dataset) -> xr.Dataset:
    if "valid_time" in ds.coords and "time" not in ds.coords:
        ds = ds.rename({"valid_time": "time"})
    return ds


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()

    if args.period and args.per_year:
        LOG.error("--period and --per-year are mutually exclusive")
        return 2

    if args.per_year:
        out_root = ROOT / "data" / "tiles_per_year"
        out_dir = out_root / "pressure_levels"
        if args.raw_dirs:
            raw_dirs = [ROOT / d.strip() if not Path(d.strip()).is_absolute() else Path(d.strip())
                        for d in args.raw_dirs.split(",") if d.strip()]
        else:
            raw_dirs = [DEFAULT_RAW_DIR]
            for sib in sorted((ROOT / "data").glob("raw_*")):
                if sib.is_dir() and sib.name != "raw_1961_1990":
                    raw_dirs.append(sib)
        LOG.info("per-year mode → %s", out_dir.parent.name)
        for d in raw_dirs:
            LOG.info("  raw dir: %s", d.relative_to(ROOT) if d.is_relative_to(ROOT) else d)
    elif args.period:
        start, end = (int(x) for x in args.period.split("-"))
        out_dir = ROOT / "data" / f"tiles_{start}_{end}" / "pressure_levels"
        if args.raw_dirs:
            raw_dirs = [ROOT / d.strip() if not Path(d.strip()).is_absolute() else Path(d.strip())
                        for d in args.raw_dirs.split(",") if d.strip()]
            raw_dir = raw_dirs[0]
            LOG.info("period  %d–%d  (subset from merged dirs → %s)",
                     start, end, out_dir.parent.name)
            for d in raw_dirs:
                LOG.info("  raw dir: %s", d.relative_to(ROOT) if d.is_relative_to(ROOT) else d)
        else:
            raw_dir = ROOT / "data" / f"raw_{start}_{end}"
            raw_dirs = [raw_dir]
            LOG.info("period  %d–%d  (%s → %s)", start, end, raw_dir.name, out_dir.parent.name)
    else:
        raw_dir = DEFAULT_RAW_DIR
        out_dir = DEFAULT_OUT_DIR
        raw_dirs = [raw_dir]

    try:
        from windspharm.xarray import VectorWind
    except ImportError:
        LOG.error(
            "windspharm not installed. Install with:  pip install windspharm  "
            "(brings pyspharm; on macOS you may need:  brew install gfortran  first)"
        )
        return 1

    # Open u and v across all raw dirs and concat along time. For single-dir
    # mode this is just open_dataset; for multi-dir per-year mode it's
    # open_mfdataset which transparently merges by time.
    u_paths = [d / "era5_pressure_levels_u.nc" for d in raw_dirs]
    v_paths = [d / "era5_pressure_levels_v.nc" for d in raw_dirs]
    u_paths = [p for p in u_paths if p.exists()]
    v_paths = [p for p in v_paths if p.exists()]
    if not u_paths or not v_paths:
        LOG.error("Missing u/v NetCDFs in raw dirs %s", [str(d) for d in raw_dirs])
        return 1

    LOG.info("open  u: %d file(s), v: %d file(s)", len(u_paths), len(v_paths))
    if len(u_paths) == 1:
        ds_u = _rename_time(xr.open_dataset(u_paths[0]))
        ds_v = _rename_time(xr.open_dataset(v_paths[0]))
    else:
        ds_u = _rename_time(xr.open_mfdataset(
            [str(p) for p in u_paths], combine="by_coords", preprocess=_rename_time))
        ds_v = _rename_time(xr.open_mfdataset(
            [str(p) for p in v_paths], combine="by_coords", preprocess=_rename_time))

    u = ds_u["u"]
    v = ds_v["v"]

    # Subset to the requested period when --period was combined with
    # --raw-dirs to build a climatology over an arbitrary year window
    # from merged raw data.
    if args.period and args.raw_dirs and "time" in u.dims:
        start, end = (int(x) for x in args.period.split("-"))
        u = u.sel(time=slice(f"{start}-01-01", f"{end}-12-31"))
        v = v.sel(time=slice(f"{start}-01-01", f"{end}-12-31"))
        LOG.info("subset time axis → %d steps in [%d, %d]",
                 u.sizes.get("time", 0), start, end)

    lat_name = "latitude" if "latitude" in u.dims else "lat"
    lon_name = "longitude" if "longitude" in u.dims else "lon"

    # Downsample spatially before computing — SHT cost scales with resolution².
    step = max(1, int(round(args.resolution / SRC_RES)))
    if step > 1:
        u = u.isel({lat_name: slice(None, None, step), lon_name: slice(None, None, step)})
        v = v.isel({lat_name: slice(None, None, step), lon_name: slice(None, None, step)})

    LOG.info("compute Helmholtz (this is the slow step — SHT per timestep)")
    t0 = time.time()
    w = VectorWind(u, v)
    chi = w.velocitypotential()      # m² s⁻¹
    psi = w.streamfunction()         # m² s⁻¹
    LOG.info("done   helmholtz in %.0fs", time.time() - t0)

    if args.per_year:
        # Per-year mode: skip climatology grouping entirely. We pass the raw
        # (time × level × lat × lon) chi/psi arrays straight to the writer,
        # which iterates over time and emits one tile per (level, year, month).
        chi_mean = chi
        psi_mean = psi
        chi_std = psi_std = None
    else:
        LOG.info("clim   month-of-year mean / std")
        grouped_chi = chi.groupby("time.month")
        grouped_psi = psi.groupby("time.month")
        chi_mean = grouped_chi.mean("time")
        psi_mean = grouped_psi.mean("time")
        if args.no_std:
            chi_std = psi_std = None
        else:
            chi_std = grouped_chi.std("time")
            psi_std = grouped_psi.std("time")

    lev_name = "pressure_level" if "pressure_level" in chi_mean.dims else "level"
    lat_name = "latitude" if "latitude" in chi_mean.dims else "lat"
    lon_name = "longitude" if "longitude" in chi_mean.dims else "lon"

    levels = sorted([int(p) for p in chi_mean[lev_name].values])
    nlat = chi_mean.sizes[lat_name]
    nlon = chi_mean.sizes[lon_name]
    lat_vals = chi_mean[lat_name].values
    lon_vals = chi_mean[lon_name].values
    lat_desc = bool(lat_vals[0] > lat_vals[-1])

    if args.per_year:
        # Force-load to memory once so the per-tile slicing in the loop below
        # doesn't keep reaching back to the source NetCDFs / spectral output.
        chi_mean = chi_mean.load()
        psi_mean = psi_mean.load()
        years = sorted(set(int(t) for t in chi_mean.time.dt.year.values))
        ymonths = sorted({(int(t.dt.year.item()), int(t.dt.month.item())) for t in chi_mean.time})
        LOG.info("peryr  years=%d–%d  months=%d  levels=%d", years[0], years[-1], len(ymonths), len(levels))

    for short, mean_da, std_da, long_name, units in [
        ("chi", chi_mean, chi_std, "Velocity potential", "m**2 s**-1"),
        ("psi", psi_mean, psi_std, "Streamfunction",      "m**2 s**-1"),
    ]:
        out_subdir = out_dir / short
        if out_subdir.exists() and not args.force:
            LOG.info("skip   %s (exists — pass --force to rebuild)", short)
            continue
        out_subdir.mkdir(parents=True, exist_ok=True)

        if args.per_year:
            for ti in range(mean_da.sizes["time"]):
                year  = int(mean_da.time.dt.year[ti].item())
                month = int(mean_da.time.dt.month[ti].item())
                snap = mean_da.isel(time=ti)
                for lev in levels:
                    arr = snap.sel({lev_name: lev}).values.astype("<f4")
                    (out_subdir / f"{lev}_{year}_{month:02d}.bin").write_bytes(arr.tobytes())
        else:
            for lev in levels:
                for month in range(1, 13):
                    arr = mean_da.sel({lev_name: lev, "month": month}).values.astype("<f4")
                    (out_subdir / f"{lev}_{month:02d}.bin").write_bytes(arr.tobytes())
                    if std_da is not None:
                        arrS = std_da.sel({lev_name: lev, "month": month}).values.astype("<f4")
                        (out_subdir / f"std_{lev}_{month:02d}.bin").write_bytes(arrS.tobytes())

        meta = {
            "var": short,
            "group": "pressure_levels",
            "long_name": long_name,
            "units": units,
            "shape": [nlat, nlon],
            "lat_descending": lat_desc,
            "lat_first": float(lat_vals[0]),
            "lat_last":  float(lat_vals[-1]),
            "lon_first": float(lon_vals[0]),
            "lon_last":  float(lon_vals[-1]),
            "vmin": float(mean_da.min()),
            "vmax": float(mean_da.max()),
            "has_std": std_da is not None,
            "std_vmin": float(std_da.min()) if std_da is not None else None,
            "std_vmax": float(std_da.max()) if std_da is not None else None,
            "levels": levels,
            "resolution_deg": args.resolution,
            "source_nc": "derived from era5_pressure_levels_{u,v}.nc",
        }
        if args.per_year:
            meta["years"] = years
            meta["year_months"] = [[y, m] for (y, m) in ymonths]
            meta["source_dirs"] = [str(d.name) for d in raw_dirs]
        (out_subdir / "meta.json").write_text(json.dumps(meta, indent=2))
        LOG.info("done   %s   range=[%.3g, %.3g]", short, meta["vmin"], meta["vmax"])

    LOG.info("regen  manifest.json")
    # The output dir is .../tiles/pressure_levels (or .../tiles_PERIOD/pressure_levels);
    # walk up one level to find the tiles root that contains both groups.
    refresh_manifest(out_dir.parent)
    return 0


def refresh_manifest(tiles_root: Path):
    """Walk a tiles root and regenerate manifest.json — same logic build_tiles.py uses."""
    groups: dict = {}
    for group_dir in sorted(tiles_root.iterdir()):
        if not group_dir.is_dir():
            continue
        vars_: dict = {}
        for var_dir in sorted(group_dir.iterdir()):
            mp = var_dir / "meta.json"
            if mp.exists():
                vars_[var_dir.name] = json.loads(mp.read_text())
        if vars_:
            groups[group_dir.name] = vars_
    (tiles_root / "manifest.json").write_text(json.dumps({"groups": groups}, indent=2))


if __name__ == "__main__":
    sys.exit(main())
