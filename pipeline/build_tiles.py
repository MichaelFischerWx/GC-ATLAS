"""Convert raw ERA5 NetCDFs into per-(var, level, month) binary tiles.

Reads data/raw/era5_<group>_<var>.nc, computes a 12-month-of-year climatology
(groupby 'time.month' + mean), optionally downsamples, and writes one
Float32 binary per (variable, level, month) alongside a meta.json per variable
and a top-level manifest.json.

Output layout:
    data/tiles/
        manifest.json
        pressure_levels/
            u/
                meta.json
                10_01.bin  …  1000_12.bin      (level_month.bin)
            v/ …
        single_levels/
            msl/
                meta.json
                01.bin  …  12.bin              (month.bin)
            t2m/ …

Binary format: Float32 little-endian, row-major [lat × lon].

Usage:
    python pipeline/build_tiles.py                  # all raw files
    python pipeline/build_tiles.py --var u
    python pipeline/build_tiles.py --group single_levels
    python pipeline/build_tiles.py --resolution 0.5 # keep native
    python pipeline/build_tiles.py --force
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

# If a .nc file was modified in the last N seconds, treat it as still being
# written by the download script and skip it rather than crashing on a partial
# HDF5 file.
FRESH_FILE_GRACE_SEC = 120

LOG = logging.getLogger("gc-atlas.build_tiles")
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "data" / "tiles"

# Native grid of the CDS download (we requested 0.5°).
SRC_RES = 0.5


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--var", help="short name filter (e.g. u)")
    ap.add_argument("--group", choices=["pressure_levels", "single_levels"])
    ap.add_argument("--resolution", type=float, default=1.0,
                    help="target grid spacing in degrees (default 1.0; source is 0.5)")
    ap.add_argument("--force", action="store_true", help="rebuild even if output exists")
    return ap.parse_args()


def _rename_time(ds: xr.Dataset) -> xr.Dataset:
    """Normalise the time coordinate name (CDS sometimes uses valid_time)."""
    if "valid_time" in ds.coords and "time" not in ds.coords:
        ds = ds.rename({"valid_time": "time"})
    return ds


def process(nc_path: Path, res: float, force: bool) -> None:
    stem = nc_path.stem              # e.g. era5_pressure_levels_u
    parts = stem.split("_")
    if parts[0] != "era5" or len(parts) < 3:
        LOG.warning("skip  unknown filename %s", nc_path.name)
        return
    group = "_".join(parts[1:-1])    # pressure_levels | single_levels
    short = parts[-1]                # u | v | msl | ...

    out_dir = OUT_DIR / group / short
    if out_dir.exists() and not force:
        LOG.info("skip  %s/%s  (exists — use --force to rebuild)", group, short)
        return

    age = time.time() - nc_path.stat().st_mtime
    if age < FRESH_FILE_GRACE_SEC:
        LOG.info("skip  %s  (modified %ds ago — still being written?)", nc_path.name, int(age))
        return

    LOG.info("open  %s", nc_path.name)
    try:
        ds = _rename_time(xr.open_dataset(nc_path))
    except (OSError, RuntimeError) as exc:
        LOG.warning("skip  %s  (open failed: %s)", nc_path.name, exc)
        return

    # Identify the data variable. CDS returns one per request in our pipeline;
    # if there are multiple, prefer our short name, otherwise take the first.
    candidates = list(ds.data_vars)
    if short in candidates:
        var_name = short
    elif len(candidates) == 1:
        var_name = candidates[0]
    else:
        LOG.error("can't pick variable for %s (candidates: %s)", nc_path.name, candidates)
        return
    da = ds[var_name]

    LOG.info("clim  %s  (%d times → 12 months of year)", short, da.sizes.get("time", -1))
    clim = da.groupby("time.month").mean("time", keep_attrs=True)

    # Downsample spatially.
    lat_name = "latitude"  if "latitude"  in clim.dims else "lat"
    lon_name = "longitude" if "longitude" in clim.dims else "lon"
    step = max(1, int(round(res / SRC_RES)))
    if step > 1:
        clim = clim.isel({lat_name: slice(None, None, step),
                          lon_name: slice(None, None, step)})

    lev_name = "pressure_level" if "pressure_level" in clim.dims else (
        "level" if "level" in clim.dims else None)
    has_level = lev_name is not None

    vmin = float(clim.min())
    vmax = float(clim.max())
    nlat = clim.sizes[lat_name]
    nlon = clim.sizes[lon_name]

    # Sanity-check lat ordering: ERA5 delivers 90 → −90. We keep that.
    lat_vals = clim[lat_name].values
    lon_vals = clim[lon_name].values
    lat_desc = bool(lat_vals[0] > lat_vals[-1])

    out_dir.mkdir(parents=True, exist_ok=True)

    levels: list[int] | None = None
    if has_level:
        levels = sorted([int(p) for p in clim[lev_name].values])
        for lev in levels:
            for month in range(1, 13):
                arr = clim.sel({lev_name: lev, "month": month}).values.astype("<f4")
                (out_dir / f"{lev}_{month:02d}.bin").write_bytes(arr.tobytes())
    else:
        for month in range(1, 13):
            arr = clim.sel(month=month).values.astype("<f4")
            (out_dir / f"{month:02d}.bin").write_bytes(arr.tobytes())

    meta = {
        "var": short,
        "group": group,
        "long_name": str(da.attrs.get("long_name", "")),
        "units": str(da.attrs.get("units", "")),
        "shape": [nlat, nlon],
        "lat_descending": lat_desc,
        "lat_first": float(lat_vals[0]),
        "lat_last":  float(lat_vals[-1]),
        "lon_first": float(lon_vals[0]),
        "lon_last":  float(lon_vals[-1]),
        "vmin": vmin,
        "vmax": vmax,
        "levels": levels,
        "resolution_deg": res,
        "source_nc": nc_path.name,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    LOG.info("done  %s/%s  %dx%d  levels=%s  range=[%.3g, %.3g]",
             group, short, nlat, nlon,
             "n/a" if levels is None else len(levels), vmin, vmax)


def write_manifest() -> None:
    groups: dict = {}
    for group_dir in sorted(OUT_DIR.iterdir()):
        if not group_dir.is_dir():
            continue
        vars_: dict = {}
        for var_dir in sorted(group_dir.iterdir()):
            mp = var_dir / "meta.json"
            if mp.exists():
                vars_[var_dir.name] = json.loads(mp.read_text())
        if vars_:
            groups[group_dir.name] = vars_
    manifest = {"groups": groups}
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
    LOG.info("manifest written → %s", OUT_DIR / "manifest.json")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for nc in sorted(RAW_DIR.glob("era5_*.nc")):
        parts = nc.stem.split("_")
        group = "_".join(parts[1:-1])
        short = parts[-1]
        if args.var and args.var != short:
            continue
        if args.group and args.group != group:
            continue
        try:
            process(nc, args.resolution, args.force)
        except Exception as exc:
            LOG.error("FAIL  %s: %s", nc.name, exc)

    write_manifest()
    return 0


if __name__ == "__main__":
    sys.exit(main())
