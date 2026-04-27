"""Add new pressure levels to the existing GC-ATLAS tile tree.

Designed for additive expansion (e.g. interpolating between 700 and 500 hPa
with new 600 + 400 hPa tiles to improve MPI / CAPE-based diagnostics)
WITHOUT having to re-download or re-tile any of the existing 12 levels.

What it does:
  1. Fetches ONLY the requested levels from CDS into sidecar NetCDFs
     (data/raw/era5_pressure_levels_<var>__add_<L1>_<L2>.nc).
  2. Builds tiles for those levels alongside the existing ones, using the
     same {level}_{month:02d}.bin / {level}_{year}_{month:02d}.bin format
     build_tiles.py emits.
  3. Runs windspharm Helmholtz on the new-level u/v slices to extend
     chi (velocity potential) and psi (streamfunction) onto the same
     levels.
  4. Updates each variable's meta.json `levels` array (sorted, deduped)
     and recomputes vmin/vmax over the union of old + new tiles.
  5. Re-writes manifest.json so the frontend dropdown picks up the new
     levels automatically (globe.js reads `levels` from the manifest).
  6. Optionally gzips the new .bin files so they match the existing
     .bin.gz tile encoding.

Three modes mirror build_tiles.py:
    --period 1991-2020 (default)         climatology tree → data/tiles/
    --period 1961-1990                   alternate climo  → data/tiles_1961_1990/
    --per-year                           per-year tree    → data/tiles_per_year/

Usage:
    # Add 400 + 600 hPa to the 1991-2020 climatology + per-year tree:
    python pipeline/add_pressure_levels.py --levels 400,600
    python pipeline/add_pressure_levels.py --levels 400,600 --per-year

    # Skip download (sidecars already on disk):
    python pipeline/add_pressure_levels.py --levels 400,600 --no-download

    # Just the t/q vars (e.g. for a focused MPI build):
    python pipeline/add_pressure_levels.py --levels 400,600 --vars t,q --no-helmholtz
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

LOG = logging.getLogger("gc-atlas.add_levels")
ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "configs" / "era5_variables.yaml"
SRC_RES = 0.5

# These are computed from u/v after the new-level fetch — not directly
# downloaded. Listed separately so we don't try to CDS-request them.
HELMHOLTZ_VARS = ("chi", "psi")

# Pattern matching raw dirs whose name encodes a year span (raw_1961_1990,
# raw_2021_2026, …). The plain "raw" dir falls back to the era5_variables.yaml
# default period (1991-2020).
_RAW_DIR_SPAN_RE = re.compile(r'^raw_(\d{4})_(\d{4})$')


def raw_dir_span(raw_dir: Path, default_span: tuple[int, int]) -> tuple[int, int]:
    """Year span this raw dir covers. Mirrors build_tiles.py's convention:
    raw_YYYY_YYYY → those years; plain raw → era5_variables.yaml default."""
    m = _RAW_DIR_SPAN_RE.match(raw_dir.name)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    return default_span


# ── Sidecar download ──────────────────────────────────────────
def sidecar_path(raw_dir: Path, short: str, levels: list[int]) -> Path:
    suffix = "_".join(str(L) for L in sorted(levels))
    return raw_dir / f"era5_pressure_levels_{short}__add_{suffix}.nc"


def fetch_levels(client, var: dict, levels: list[int], cfg: dict,
                 start: int, end: int, out_path: Path) -> None:
    req = {
        "product_type": "monthly_averaged_reanalysis",
        "variable": var["cds_name"],
        "year": [str(y) for y in range(start, end + 1)],
        "month": [f"{m:02d}" for m in range(1, 13)],
        "time": "00:00",
        "grid": [cfg["grid"], cfg["grid"]],
        "area": cfg["area"],
        "data_format": "netcdf",
        "pressure_level": [str(L) for L in levels],
    }
    LOG.info("CDS  %s  levels=%s  years=%d-%d", var["short"], levels, start, end)
    t0 = time.time()
    client.retrieve("reanalysis-era5-pressure-levels-monthly-means", req, str(out_path))
    LOG.info("done %s  (%.0f MB, %.0fs)",
             out_path.name, out_path.stat().st_size / 1e6, time.time() - t0)


# ── Tile writers (mirrors build_tiles.py format exactly) ──────
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


def _lev_name(da: xr.DataArray) -> str:
    if "pressure_level" in da.dims:
        return "pressure_level"
    if "level" in da.dims:
        return "level"
    raise ValueError("No pressure_level / level dim found")


def write_climatology_levels(da: xr.DataArray, levels: list[int],
                             out_dir: Path, res: float, write_std: bool) -> None:
    """For each new level, write {level}_{month}.bin (+ std_{level}_{month}.bin)
    into out_dir alongside the existing tiles. Returns nothing — the meta.json
    update happens later in update_meta()."""
    da = _downsample(da, res)
    grouped = da.groupby("time.month")
    clim = grouped.mean("time", keep_attrs=True)
    std = grouped.std("time", keep_attrs=True) if write_std else None

    lev = _lev_name(clim)
    out_dir.mkdir(parents=True, exist_ok=True)
    for L in levels:
        if L not in clim[lev].values:
            LOG.warning("level %d not in DataArray (have %s) — skip", L, list(clim[lev].values))
            continue
        for month in range(1, 13):
            arr = clim.sel({lev: L, "month": month}).values.astype("<f4")
            (out_dir / f"{L}_{month:02d}.bin").write_bytes(arr.tobytes())
            if std is not None:
                arrS = std.sel({lev: L, "month": month}).values.astype("<f4")
                (out_dir / f"std_{L}_{month:02d}.bin").write_bytes(arrS.tobytes())


def write_per_year_levels(da: xr.DataArray, levels: list[int],
                          out_dir: Path, res: float) -> None:
    """For each new level, write {level}_{year}_{month:02d}.bin into out_dir."""
    da = _downsample(da, res)
    da = da.load()  # one-shot decode; per-tile slicing below is in-memory
    lev = _lev_name(da)
    out_dir.mkdir(parents=True, exist_ok=True)
    for ti in range(da.sizes["time"]):
        year  = int(da.time.dt.year[ti].item())
        month = int(da.time.dt.month[ti].item())
        snap = da.isel(time=ti)
        for L in levels:
            if L not in snap[lev].values:
                continue
            arr = snap.sel({lev: L}).values.astype("<f4")
            (out_dir / f"{L}_{year}_{month:02d}.bin").write_bytes(arr.tobytes())


# ── Helmholtz on the new levels ──────────────────────────────
def compute_helmholtz_at_levels(u_da: xr.DataArray, v_da: xr.DataArray,
                                levels: list[int]) -> tuple[xr.DataArray, xr.DataArray]:
    """Slice u/v to the requested levels, then run windspharm to get chi/psi.
    windspharm operates per-level independently, so this is exactly equivalent
    to running on the full stack and then sub-selecting — but ~6× faster
    because we skip levels we already have."""
    from windspharm.xarray import VectorWind

    lev = _lev_name(u_da)
    u_sub = u_da.sel({lev: levels})
    v_sub = v_da.sel({lev: levels})

    LOG.info("helmholtz on levels=%s  (this is the slow step)", levels)
    t0 = time.time()
    w = VectorWind(u_sub, v_sub)
    chi = w.velocitypotential()
    psi = w.streamfunction()
    LOG.info("done helmholtz in %.0fs", time.time() - t0)
    return chi, psi


# ── meta.json + manifest update ──────────────────────────────
def _scan_tile_minmax(var_dir: Path, kind: str = "mean") -> tuple[float, float]:
    """Walk every .bin / .bin.gz tile in var_dir matching `kind` and return
    the global (vmin, vmax). kind='mean' picks plain {level?}_{month}.bin;
    kind='std' picks std_{level?}_{month}.bin. Read all → np.fromfile is fine
    for our largest case (~ a few GB across all years), but in practice
    climatology tiles are 12 files × 12 levels = 144 of ~1MB each."""
    vmin, vmax = np.inf, -np.inf
    for tile in var_dir.iterdir():
        name = tile.name
        if not name.endswith((".bin", ".bin.gz")):
            continue
        is_std = name.startswith("std_")
        if kind == "mean" and is_std:
            continue
        if kind == "std" and not is_std:
            continue
        if name.endswith(".bin.gz"):
            with gzip.open(tile, "rb") as f:
                buf = f.read()
        else:
            buf = tile.read_bytes()
        arr = np.frombuffer(buf, dtype="<f4")
        if arr.size == 0:
            continue
        finite = arr[np.isfinite(arr)]
        if finite.size:
            vmin = min(vmin, float(finite.min()))
            vmax = max(vmax, float(finite.max()))
    return vmin, vmax


def update_meta(var_dir: Path, new_levels: list[int],
                rescan_minmax: bool = True) -> None:
    """Append new_levels to the existing meta.json's `levels` array (sorted,
    deduped) and optionally rescan vmin/vmax over the union of old + new
    tiles. Idempotent — safe to re-run after re-adding a level."""
    mp = var_dir / "meta.json"
    if not mp.exists():
        LOG.warning("no meta.json in %s — skip update", var_dir)
        return
    meta = json.loads(mp.read_text())
    existing = list(meta.get("levels") or [])
    merged = sorted(set(existing + list(new_levels)))
    meta["levels"] = merged

    if rescan_minmax:
        vmin, vmax = _scan_tile_minmax(var_dir, kind="mean")
        if np.isfinite(vmin) and np.isfinite(vmax):
            meta["vmin"], meta["vmax"] = vmin, vmax
        if meta.get("has_std"):
            svmin, svmax = _scan_tile_minmax(var_dir, kind="std")
            if np.isfinite(svmin) and np.isfinite(svmax):
                meta["std_vmin"], meta["std_vmax"] = svmin, svmax

    mp.write_text(json.dumps(meta, indent=2))
    LOG.info("meta %s  levels=%s", var_dir.name, merged)


def write_helmholtz_meta(var_dir: Path, da: xr.DataArray, short: str,
                         long_name: str, units: str, levels: list[int]) -> None:
    """First-time meta.json for chi/psi when adding levels to a tree that
    didn't have them yet. (Existing trees already have meta.json — this
    branch just won't run.)"""
    if (var_dir / "meta.json").exists():
        update_meta(var_dir, levels)
        return
    lat_name = "latitude" if "latitude" in da.dims else "lat"
    lon_name = "longitude" if "longitude" in da.dims else "lon"
    lat_vals = da[lat_name].values
    lon_vals = da[lon_name].values
    meta = {
        "var": short,
        "group": "pressure_levels",
        "long_name": long_name,
        "units": units,
        "shape": [da.sizes[lat_name], da.sizes[lon_name]],
        "lat_descending": bool(lat_vals[0] > lat_vals[-1]),
        "lat_first": float(lat_vals[0]),
        "lat_last":  float(lat_vals[-1]),
        "lon_first": float(lon_vals[0]),
        "lon_last":  float(lon_vals[-1]),
        "vmin": float(da.min()), "vmax": float(da.max()),
        "has_std": False,
        "levels": sorted(levels),
    }
    (var_dir / "meta.json").write_text(json.dumps(meta, indent=2))


def rewrite_manifest(out_dir: Path) -> None:
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
    LOG.info("manifest written → %s", out_dir / "manifest.json")


# ── Compression (mirrors compress_tiles.py) ───────────────────
def gzip_new_tiles(var_dir: Path, levels: list[int]) -> None:
    """Gzip the .bin files we just wrote so they match the existing
    .bin.gz encoding. Removes the .bin afterwards. Skips files that are
    already .bin.gz (idempotent)."""
    for tile in list(var_dir.iterdir()):
        name = tile.name
        if not name.endswith(".bin"):
            continue
        # Only compress tiles for the new levels — leave others alone.
        if not any(name.startswith(f"{L}_") or name.startswith(f"std_{L}_")
                   for L in levels):
            continue
        gz = tile.with_suffix(".bin.gz")
        with tile.open("rb") as fin, gzip.open(gz, "wb", compresslevel=6) as fout:
            fout.write(fin.read())
        tile.unlink()


# ── Driver ────────────────────────────────────────────────────
def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--levels", required=True,
                    help="comma-separated new levels in hPa (e.g. 400,600)")
    ap.add_argument("--vars",
                    help="comma-separated short names to add (default: all "
                         "pressure-level vars from era5_variables.yaml + chi/psi)")
    ap.add_argument("--period",
                    help="START-END (default: era5_variables.yaml period). "
                         "Output goes to data/tiles_START_END/.")
    ap.add_argument("--per-year", action="store_true",
                    help="emit per-year tiles into data/tiles_per_year/ instead")
    ap.add_argument("--raw-dirs",
                    help="comma-separated raw dirs to merge (per-year mode). "
                         "Default: data/raw[,data/raw_2021_2026 if present]")
    ap.add_argument("--resolution", type=float, default=1.0,
                    help="target grid spacing (default 1.0; native is 0.5)")
    ap.add_argument("--no-download", action="store_true",
                    help="use existing sidecar NetCDFs (skip CDS fetch)")
    ap.add_argument("--no-helmholtz", action="store_true",
                    help="skip chi/psi computation (only direct-fetched vars)")
    ap.add_argument("--no-compress", action="store_true",
                    help="skip gzipping new .bin files")
    ap.add_argument("--no-std", action="store_true",
                    help="skip std tiles (climatology mode only)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would happen, no fetch / tile writes")
    return ap.parse_args()


def resolve_raw_dirs(args, period_start: int, period_end: int) -> list[Path]:
    if args.raw_dirs:
        return [ROOT / d.strip() if not Path(d.strip()).is_absolute() else Path(d.strip())
                for d in args.raw_dirs.split(",") if d.strip()]
    if args.per_year:
        # Match the existing per-year tree's coverage. The deployed
        # tiles_per_year/ on GCS lists source_dirs=[raw_1961_1990, raw,
        # raw_2021_2026], so we include raw_1961_1990 here too — adding
        # 400/600 hPa to the post-1991 portion only would leave the new
        # levels missing for any 1961-1990 fix in single-year mode.
        dirs = [ROOT / "data" / "raw"]
        for sib in sorted((ROOT / "data").glob("raw_*")):
            if sib.is_dir():
                dirs.append(sib)
        return dirs
    # Climatology mode: one raw dir matched to the period.
    if (period_start, period_end) == (1991, 2020):
        return [ROOT / "data" / "raw"]
    return [ROOT / "data" / f"raw_{period_start}_{period_end}"]


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()

    levels = sorted(int(x) for x in args.levels.split(",") if x.strip())
    if not levels:
        LOG.error("no levels parsed from %s", args.levels)
        return 2

    cfg = yaml.safe_load(CONFIG_PATH.read_text())
    pl_cfg = cfg["datasets"]["pressure_levels"]
    all_pl_vars = [v["short"] for v in pl_cfg["variables"]]

    if args.vars:
        wanted = [s.strip() for s in args.vars.split(",") if s.strip()]
    else:
        wanted = list(all_pl_vars) + (list(HELMHOLTZ_VARS) if not args.no_helmholtz else [])

    period_start = cfg["period"]["start"]
    period_end   = cfg["period"]["end"]
    if args.period:
        period_start, period_end = (int(x) for x in args.period.split("-"))

    raw_dirs = resolve_raw_dirs(args, period_start, period_end)
    primary_raw = raw_dirs[0]
    primary_raw.mkdir(parents=True, exist_ok=True)

    # Output dir + tree mode
    if args.per_year:
        out_dir = ROOT / "data" / "tiles_per_year"
        mode = "per-year"
    elif (period_start, period_end) == (1991, 2020):
        out_dir = ROOT / "data" / "tiles"
        mode = "climatology"
    else:
        out_dir = ROOT / "data" / f"tiles_{period_start}_{period_end}"
        mode = "climatology"
    out_dir.mkdir(parents=True, exist_ok=True)

    LOG.info("mode=%s  out=%s  period=%d-%d  levels=%s  vars=%s",
             mode, out_dir.relative_to(ROOT), period_start, period_end, levels, wanted)
    for d in raw_dirs:
        LOG.info("  raw dir: %s", d.relative_to(ROOT) if d.is_relative_to(ROOT) else d)

    # 1) Download sidecar NetCDFs (one per CDS-fetchable var; chi/psi excluded).
    # In per-year mode, we fetch a sidecar in EVERY raw dir for the year span
    # that dir covers — so the merged time axis spans 1961-2026 (or whatever
    # the user has). In climatology mode we only fetch for the primary dir.
    direct_vars = [v for v in wanted if v in all_pl_vars]
    default_span = (cfg["period"]["start"], cfg["period"]["end"])

    if args.per_year:
        fetch_targets = [(d, raw_dir_span(d, default_span)) for d in raw_dirs]
    else:
        fetch_targets = [(primary_raw, (period_start, period_end))]

    # sidecars: short → list[Path], one path per raw dir we fetched into
    sidecars: dict[str, list[Path]] = {s: [] for s in direct_vars}
    if args.no_download:
        for short in direct_vars:
            for raw_dir, _ in fetch_targets:
                sp = sidecar_path(raw_dir, short, levels)
                if sp.exists():
                    sidecars[short].append(sp)
                else:
                    LOG.warning("--no-download: missing %s", sp)
    elif not args.dry_run:
        import cdsapi
        client = cdsapi.Client()
        for short in direct_vars:
            var_meta = next(v for v in pl_cfg["variables"] if v["short"] == short)
            for raw_dir, (s, e) in fetch_targets:
                sp = sidecar_path(raw_dir, short, levels)
                raw_dir.mkdir(parents=True, exist_ok=True)
                if sp.exists():
                    LOG.info("skip %s sidecar exists", sp.name)
                    sidecars[short].append(sp)
                    continue
                fetch_levels(client, var_meta, levels, cfg, s, e, sp)
                sidecars[short].append(sp)
    else:
        LOG.info("dry-run: would fetch sidecars for %s in dirs %s",
                 direct_vars, [str(d.name) for d, _ in fetch_targets])
        return 0

    # 2) Build tiles for each direct var. When multiple sidecars exist
    # (per-year mode w/ multiple raw dirs), merge along time before tiling
    # so the per-year writer sees one continuous time axis.
    def _open_merged(paths: list[Path]) -> xr.Dataset:
        if len(paths) == 1:
            return _rename_time(xr.open_dataset(paths[0]))
        return _rename_time(xr.open_mfdataset(
            [str(p) for p in paths], combine="by_coords", preprocess=_rename_time))

    for short in direct_vars:
        sps = sidecars.get(short, [])
        if not sps:
            LOG.warning("missing sidecar for %s — skip", short)
            continue
        LOG.info("tiles %s/%s  ←  %s", "pressure_levels", short,
                 ", ".join(p.name for p in sps))
        ds = _open_merged(sps)
        var_name = short if short in ds.data_vars else list(ds.data_vars)[0]
        da = ds[var_name]
        var_dir = out_dir / "pressure_levels" / short
        if args.per_year:
            write_per_year_levels(da, levels, var_dir, args.resolution)
        else:
            write_climatology_levels(da, levels, var_dir, args.resolution,
                                     write_std=not args.no_std)
        update_meta(var_dir, levels, rescan_minmax=True)
        if not args.no_compress:
            gzip_new_tiles(var_dir, levels)

    # 3) Helmholtz: extend chi/psi at the new levels
    if not args.no_helmholtz and any(s in wanted for s in HELMHOLTZ_VARS):
        u_sps = sidecars.get("u", [])
        v_sps = sidecars.get("v", [])
        if not u_sps or not v_sps:
            LOG.warning("u/v sidecars missing — can't extend chi/psi. "
                        "Re-run with --vars u,v in the wanted set.")
        else:
            ds_u = _open_merged(u_sps)["u"]
            ds_v = _open_merged(v_sps)["v"]
            ds_u = _downsample(ds_u, args.resolution)
            ds_v = _downsample(ds_v, args.resolution)
            chi, psi = compute_helmholtz_at_levels(ds_u, ds_v, levels)
            chi = chi.rename("chi"); psi = psi.rename("psi")

            for short, da, long_name in [
                ("chi", chi, "Velocity potential"),
                ("psi", psi, "Streamfunction"),
            ]:
                if short not in wanted:
                    continue
                var_dir = out_dir / "pressure_levels" / short
                if args.per_year:
                    write_per_year_levels(da, levels, var_dir, res=args.resolution)
                else:
                    # No std for derived chi/psi at the new levels — matches
                    # build_helmholtz default behaviour for added levels.
                    da_clim = da.groupby("time.month").mean("time")
                    var_dir.mkdir(parents=True, exist_ok=True)
                    lev = _lev_name(da_clim)
                    for L in levels:
                        for m in range(1, 13):
                            arr = da_clim.sel({lev: L, "month": m}).values.astype("<f4")
                            (var_dir / f"{L}_{m:02d}.bin").write_bytes(arr.tobytes())
                write_helmholtz_meta(var_dir, da, short, long_name, "m**2 s**-1", levels)
                if not args.no_compress:
                    gzip_new_tiles(var_dir, levels)

    # 4) Re-write the manifest
    rewrite_manifest(out_dir)
    LOG.info("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
