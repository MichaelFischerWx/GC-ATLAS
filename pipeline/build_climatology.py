"""Collapse 30-year ERA5 monthly means into a 12-month-of-year climatology.

Reads data/raw/era5_<group>_<var>.nc produced by download_era5.py.
For each variable, groups by calendar month, averages over years, and writes
to a Zarr store at data/climatology.zarr/<var>.

Output dimensions per variable:
    pressure-level fields:  (month=12, level, lat, lon)
    surface fields:         (month=12, lat, lon)

Usage:
    python pipeline/build_climatology.py
    python pipeline/build_climatology.py --var u
    python pipeline/build_climatology.py --force
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import xarray as xr
import yaml

LOG = logging.getLogger("gc-atlas.climatology")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "configs" / "era5_variables.yaml"
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "data" / "climatology.zarr"


def compute_clim(raw_path: Path, short: str, group_name: str) -> xr.Dataset:
    ds = xr.open_dataset(raw_path)

    # CDS sometimes returns the time coord as 'time' or 'valid_time' depending
    # on backend/request-format. Normalize.
    if "valid_time" in ds.dims and "time" not in ds.dims:
        ds = ds.rename({"valid_time": "time"})

    clim = ds.groupby("time.month").mean("time", keep_attrs=True)

    # Preserve variable-level metadata from config for downstream tooling.
    cfg = yaml.safe_load(CONFIG_PATH.read_text())
    for grp_cfg in cfg["datasets"].values():
        for v in grp_cfg["variables"]:
            if v["short"] == short and short in clim:
                clim[short].attrs.setdefault("long_name", v["long"])
                clim[short].attrs.setdefault("units", v["units"])
                break

    clim.attrs.update({
        "title": "GC-ATLAS ERA5 monthly climatology",
        "base_period": f"{cfg['period']['start']}-{cfg['period']['end']}",
        "grid_deg": cfg["grid"],
        "source": "Copernicus Climate Data Store (CDS)",
        "group": group_name,
    })
    return clim


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--var", help="only this short name")
    ap.add_argument("--group", choices=["pressure_levels", "single_levels"])
    ap.add_argument("--force", action="store_true")
    return ap.parse_args()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()

    cfg = yaml.safe_load(CONFIG_PATH.read_text())
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    processed, missing = 0, 0
    for group_name, group_cfg in cfg["datasets"].items():
        if args.group and args.group != group_name:
            continue
        for var in group_cfg["variables"]:
            if args.var and args.var != var["short"]:
                continue
            raw = RAW_DIR / f"era5_{group_name}_{var['short']}.nc"
            if not raw.exists():
                LOG.info("miss   %s  (no raw file — run download first)", var["short"])
                missing += 1
                continue

            out = OUT_DIR / var["short"]
            if out.exists() and not args.force:
                LOG.info("skip   %s  (exists — use --force to rebuild)", var["short"])
                continue

            LOG.info("clim   %s", var["short"])
            clim = compute_clim(raw, var["short"], group_name)
            clim.to_zarr(out, mode="w")
            processed += 1

    LOG.info("summary processed=%d missing=%d", processed, missing)
    return 0


if __name__ == "__main__":
    sys.exit(main())
