"""Download ERA5 monthly-mean source data from the Copernicus CDS.

One CDS request per variable — keeps failures isolated and request sizes well
under CDS per-request limits. Skips files that already exist (resumable).

Credentials: expects ~/.cdsapirc with the user's CDS-beta API key.

Usage:
    python pipeline/download_era5.py                # fetch everything missing
    python pipeline/download_era5.py --dry-run      # print what would be fetched
    python pipeline/download_era5.py --var u        # just one field
    python pipeline/download_era5.py --group single_levels
    python pipeline/download_era5.py --force        # re-download everything
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

import yaml

LOG = logging.getLogger("gc-atlas.download")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "configs" / "era5_variables.yaml"
OUT_DIR = ROOT / "data" / "raw"


def build_request(var: dict, cfg: dict, group_name: str) -> dict:
    req = {
        "product_type": "monthly_averaged_reanalysis",
        "variable": var["cds_name"],
        "year": [str(y) for y in range(cfg["period"]["start"], cfg["period"]["end"] + 1)],
        "month": [f"{m:02d}" for m in range(1, 13)],
        "time": "00:00",
        "grid": [cfg["grid"], cfg["grid"]],
        "area": cfg["area"],
        "data_format": "netcdf",
    }
    if group_name == "pressure_levels":
        req["pressure_level"] = [str(p) for p in cfg["pressure_levels"]]
    return req


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--var", help="filter by short name (e.g. u)")
    ap.add_argument("--group", choices=["pressure_levels", "single_levels"])
    ap.add_argument("--dry-run", action="store_true", help="print requests only")
    ap.add_argument("--force", action="store_true", help="overwrite existing files")
    return ap.parse_args()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()

    cfg = yaml.safe_load(CONFIG_PATH.read_text())
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Import cdsapi lazily so --dry-run works without credentials installed.
    client = None
    if not args.dry_run:
        import cdsapi
        client = cdsapi.Client()

    queued, fetched, skipped = 0, 0, 0
    for group_name, group_cfg in cfg["datasets"].items():
        if args.group and args.group != group_name:
            continue
        for var in group_cfg["variables"]:
            if args.var and args.var != var["short"]:
                continue
            out_path = OUT_DIR / f"era5_{group_name}_{var['short']}.nc"
            if out_path.exists() and not args.force:
                LOG.info("skip    %s  (exists)", out_path.name)
                skipped += 1
                continue

            req = build_request(var, cfg, group_name)
            LOG.info("request %-34s %s", var["short"], group_cfg["dataset"])
            queued += 1
            if args.dry_run:
                continue

            t0 = time.time()
            try:
                client.retrieve(group_cfg["dataset"], req, str(out_path))
            except Exception as exc:
                LOG.error("FAILED  %s: %s", var["short"], exc)
                if out_path.exists():
                    out_path.unlink()
                continue
            LOG.info("done    %s  (%.0f MB, %.0fs)",
                     out_path.name, out_path.stat().st_size / 1e6, time.time() - t0)
            fetched += 1

    LOG.info("summary queued=%d fetched=%d skipped=%d", queued, fetched, skipped)
    return 0


if __name__ == "__main__":
    sys.exit(main())
