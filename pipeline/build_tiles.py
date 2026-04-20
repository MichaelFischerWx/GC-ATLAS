"""Convert raw ERA5 NetCDFs into per-(var, level, month) binary tiles.

Reads data/raw/era5_<group>_<var>.nc, computes a 12-month-of-year climatology
(groupby 'time.month' + mean), optionally downsamples, and writes one
Float32 binary per (variable, level, month) alongside a meta.json per variable
and a top-level manifest.json.

Output layout (climatology mode):
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

Output layout (per-year mode, --per-year):
    data/tiles_per_year/
        manifest.json
        pressure_levels/
            u/
                meta.json
                200_1991_01.bin … 200_2026_03.bin   (level_year_month.bin)
        single_levels/
            t2m/
                01_1991.bin … 12_2026.bin           (year_month.bin)
    Per-year mode skips std (a single-year stddev is meaningless) and merges
    across multiple raw directories (`--raw-dirs data/raw,data/raw_2021_2026`)
    so the time axis can span any contiguous span you've downloaded.

Binary format: Float32 little-endian, row-major [lat × lon].

Usage:
    python pipeline/build_tiles.py                                    # all raw files, climatology
    python pipeline/build_tiles.py --var u
    python pipeline/build_tiles.py --group single_levels
    python pipeline/build_tiles.py --resolution 0.5                   # keep native
    python pipeline/build_tiles.py --force
    python pipeline/build_tiles.py --period 1961-1990                 # alternate climatology window
    python pipeline/build_tiles.py --per-year \\
        --raw-dirs data/raw,data/raw_2021_2026                        # merged 1991-2026 per-year tree
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
DEFAULT_RAW_DIR = ROOT / "data" / "raw"
DEFAULT_OUT_DIR = ROOT / "data" / "tiles"

# Native grid of the CDS download (we requested 0.5°).
SRC_RES = 0.5

# Module-level globals set in main() — process() and write_manifest() read them
# instead of taking them as args, to keep the public per-file signature simple.
RAW_DIR = DEFAULT_RAW_DIR
OUT_DIR = DEFAULT_OUT_DIR
RAW_DIRS: list[Path] = [DEFAULT_RAW_DIR]    # multi-dir merge for --per-year
PER_YEAR = False


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--var", help="short name filter (e.g. u)")
    ap.add_argument("--group", choices=["pressure_levels", "single_levels"])
    ap.add_argument("--period", help="START-END, e.g. 1961-1990 (reads data/raw_START_END/, writes data/tiles_START_END/)")
    ap.add_argument("--per-year", action="store_true",
                    help="emit per-(year, month) tiles into data/tiles_per_year/ instead of climatology tiles. "
                         "Skips std (single-year std is meaningless). Combine with --raw-dirs to merge multiple raw trees.")
    ap.add_argument("--raw-dirs",
                    help="comma-separated list of raw NetCDF directories to merge along time "
                         "(per-year mode only). Default: data/raw[,data/raw_2021_2026 if present]")
    ap.add_argument("--resolution", type=float, default=1.0,
                    help="target grid spacing in degrees (default 1.0; source is 0.5)")
    ap.add_argument("--force", action="store_true", help="rebuild even if output exists")
    return ap.parse_args()


def _rename_time(ds: xr.Dataset) -> xr.Dataset:
    """Normalise the time coordinate name (CDS sometimes uses valid_time)."""
    if "valid_time" in ds.coords and "time" not in ds.coords:
        ds = ds.rename({"valid_time": "time"})
    return ds


def _open_var_for_period(group: str, short: str) -> tuple[xr.DataArray, list[Path]] | None:
    """Open + concatenate the raw NetCDFs for one variable across all RAW_DIRS.
    Returns (DataArray with merged time axis, list of source files) or None."""
    paths: list[Path] = []
    for raw_dir in RAW_DIRS:
        p = raw_dir / f"era5_{group}_{short}.nc"
        if p.exists():
            paths.append(p)
    if not paths:
        return None
    # Skip in-flight downloads to avoid HDF5 truncation errors.
    for p in paths:
        age = time.time() - p.stat().st_mtime
        if age < FRESH_FILE_GRACE_SEC:
            LOG.info("skip  %s  (modified %ds ago — still being written?)", p.name, int(age))
            return None
    try:
        if len(paths) == 1:
            ds = _rename_time(xr.open_dataset(paths[0]))
        else:
            ds = _rename_time(xr.open_mfdataset(
                [str(p) for p in paths], combine="by_coords",
                preprocess=_rename_time, decode_times=True,
            ))
    except (OSError, RuntimeError) as exc:
        LOG.warning("skip  %s/%s  (open failed: %s)", group, short, exc)
        return None
    candidates = list(ds.data_vars)
    if short in candidates:
        var_name = short
    elif len(candidates) == 1:
        var_name = candidates[0]
    else:
        LOG.error("can't pick variable for %s/%s (candidates: %s)", group, short, candidates)
        return None
    return ds[var_name], paths


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

    LOG.info("open  %s/%s", group, short)
    opened = _open_var_for_period(group, short)
    if opened is None:
        return
    da, src_paths = opened

    if PER_YEAR:
        _write_per_year(da, group, short, out_dir, res)
    else:
        _write_climatology(da, group, short, out_dir, res, src_paths[0].name)


def _write_climatology(da: xr.DataArray, group: str, short: str,
                       out_dir: Path, res: float, src_name: str) -> None:
    LOG.info("clim  %s  (%d times → 12 months of year)", short, da.sizes.get("time", -1))
    grouped = da.groupby("time.month")
    clim = grouped.mean("time", keep_attrs=True)
    # Inter-annual standard deviation per month-of-year — captures variability
    # like ENSO (peak in central tropical Pacific SST/u/T), monsoon strength
    # variability (Indian Ocean, Sahel), and storm-track interannual changes.
    # Only meaningful when there are enough years (we have 30) — for invariant
    # fields like 'oro' the std collapses to ~0 which is fine.
    std = grouped.std("time", keep_attrs=True)

    # Downsample spatially.
    lat_name = "latitude"  if "latitude"  in clim.dims else "lat"
    lon_name = "longitude" if "longitude" in clim.dims else "lon"
    step = max(1, int(round(res / SRC_RES)))
    if step > 1:
        clim = clim.isel({lat_name: slice(None, None, step),
                          lon_name: slice(None, None, step)})
        std  = std .isel({lat_name: slice(None, None, step),
                          lon_name: slice(None, None, step)})

    lev_name = "pressure_level" if "pressure_level" in clim.dims else (
        "level" if "level" in clim.dims else None)
    has_level = lev_name is not None

    vmin = float(clim.min())
    vmax = float(clim.max())
    std_vmin = float(std.min())
    std_vmax = float(std.max())
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
                arrS = std.sel({lev_name: lev, "month": month}).values.astype("<f4")
                (out_dir / f"std_{lev}_{month:02d}.bin").write_bytes(arrS.tobytes())
    else:
        for month in range(1, 13):
            arr = clim.sel(month=month).values.astype("<f4")
            (out_dir / f"{month:02d}.bin").write_bytes(arr.tobytes())
            arrS = std.sel(month=month).values.astype("<f4")
            (out_dir / f"std_{month:02d}.bin").write_bytes(arrS.tobytes())

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
        "std_vmin": std_vmin,
        "std_vmax": std_vmax,
        "has_std":  True,
        "levels": levels,
        "resolution_deg": res,
        "source_nc": src_name,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    LOG.info("done  %s/%s  %dx%d  levels=%s  range=[%.3g, %.3g]  std-range=[%.3g, %.3g]",
             group, short, nlat, nlon,
             "n/a" if levels is None else len(levels), vmin, vmax, std_vmin, std_vmax)


def _write_per_year(da: xr.DataArray, group: str, short: str,
                    out_dir: Path, res: float) -> None:
    """Emit one tile per (year, month) for the merged time series.
    No std (single-year stddev is meaningless). Tile naming:
      pressure-level: {level}_{year}_{month:02d}.bin
      single-level:   {year}_{month:02d}.bin
    """
    lat_name = "latitude"  if "latitude"  in da.dims else "lat"
    lon_name = "longitude" if "longitude" in da.dims else "lon"
    step = max(1, int(round(res / SRC_RES)))
    if step > 1:
        da = da.isel({lat_name: slice(None, None, step),
                      lon_name: slice(None, None, step)})
    lev_name = "pressure_level" if "pressure_level" in da.dims else (
        "level" if "level" in da.dims else None)
    has_level = lev_name is not None

    nlat = da.sizes[lat_name]
    nlon = da.sizes[lon_name]
    lat_vals = da[lat_name].values
    lon_vals = da[lon_name].values
    lat_desc = bool(lat_vals[0] > lat_vals[-1])

    # Force load into memory once so per-tile slicing doesn't re-decode.
    da = da.load()
    years = sorted(set(int(t) for t in da.time.dt.year.values))
    months_present = sorted({(int(t.dt.year.item()), int(t.dt.month.item())) for t in da.time})
    LOG.info("peryr %s/%s  years=%d–%d  months=%d  levels=%s",
             group, short, years[0], years[-1], len(months_present),
             "n/a" if not has_level else len(da[lev_name]))

    out_dir.mkdir(parents=True, exist_ok=True)
    levels: list[int] | None = None
    if has_level:
        levels = sorted([int(p) for p in da[lev_name].values])

    vmin = float(da.min().values)
    vmax = float(da.max().values)

    for ti in range(da.sizes["time"]):
        year  = int(da.time.dt.year[ti].item())
        month = int(da.time.dt.month[ti].item())
        snap = da.isel(time=ti)
        if has_level:
            for lev in levels:
                arr = snap.sel({lev_name: lev}).values.astype("<f4")
                (out_dir / f"{lev}_{year}_{month:02d}.bin").write_bytes(arr.tobytes())
        else:
            arr = snap.values.astype("<f4")
            (out_dir / f"{year}_{month:02d}.bin").write_bytes(arr.tobytes())

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
        "has_std":  False,
        "levels":   levels,
        "years":    years,
        "year_months": [[y, m] for (y, m) in months_present],
        "resolution_deg": res,
        "source_dirs": [str(d.name) for d in RAW_DIRS],
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    nfiles = len(months_present) * (len(levels) if levels else 1)
    LOG.info("done  %s/%s  %dx%d  tiles=%d  range=[%.3g, %.3g]",
             group, short, nlat, nlon, nfiles, vmin, vmax)


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
    global RAW_DIR, OUT_DIR, RAW_DIRS, PER_YEAR
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()
    PER_YEAR = bool(args.per_year)

    if args.period and PER_YEAR:
        LOG.error("--period and --per-year are mutually exclusive (per-year merges raw dirs explicitly)")
        return 2

    if args.period:
        start, end = (int(x) for x in args.period.split("-"))
        RAW_DIR = ROOT / "data" / f"raw_{start}_{end}"
        OUT_DIR = ROOT / "data" / f"tiles_{start}_{end}"
        RAW_DIRS = [RAW_DIR]
        LOG.info("period  %d–%d  (%s → %s)", start, end, RAW_DIR.name, OUT_DIR.name)
    elif PER_YEAR:
        OUT_DIR = ROOT / "data" / "tiles_per_year"
        if args.raw_dirs:
            RAW_DIRS = [ROOT / d.strip() if not Path(d.strip()).is_absolute() else Path(d.strip())
                        for d in args.raw_dirs.split(",") if d.strip()]
        else:
            # Auto-detect: data/raw + any data/raw_YYYY_YYYY siblings except the
            # canonical climate-change reference (raw_1961_1990, kept separate
            # so a per-year tree doesn't accidentally pool 1961-1990 into the
            # "modern" climatology).
            RAW_DIRS = [DEFAULT_RAW_DIR]
            for sib in sorted((ROOT / "data").glob("raw_*")):
                if sib.is_dir() and sib.name != "raw_1961_1990":
                    RAW_DIRS.append(sib)
        RAW_DIR = RAW_DIRS[0]
        LOG.info("per-year mode → %s", OUT_DIR.name)
        for d in RAW_DIRS:
            LOG.info("  raw dir: %s", d.relative_to(ROOT) if d.is_relative_to(ROOT) else d)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Iterate by (group, short) name pairs derived from the FIRST raw dir's
    # NetCDF list — every variable is expected to be present in every dir we
    # were told to merge. Missing files in later dirs are tolerated by
    # _open_var_for_period (it just won't find that file).
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
