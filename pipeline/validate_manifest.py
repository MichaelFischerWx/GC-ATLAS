"""Sanity-check a tile tree's manifest before it is published.

The monthly refresh (bin/era5-monthly-refresh.sh) runs unattended and
rsyncs straight to the public bucket. Two silent regressions in 2026 —
the per-year tree shrinking from 1961-present to 1991-present, and bogus
"pressure_levels_<var>__add_400" groups — were only noticed months later
in the browser. This gate catches that class of problem before upload.

Checks (per-year tree):
  * no "__add_" groups (sidecar NetCDFs tiled as variables)
  * the year span starts no later than --min-first-year for every var
  * every listed (year, month) × level has per-tile vmin/vmax metadata
    — a tile without it can't be decoded by the frontend
  * the latest (year, month) hasn't gone backwards vs. --not-before

Usage:
    python pipeline/validate_manifest.py --root data/tiles_per_year \\
        --min-first-year 1961 --not-before 2026-08
Exit status 0 = OK, 1 = problems found (printed one per line).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Levels the frontend actually requests (js/data.js LEVELS). Gaps at other
# levels (e.g. the 400/600 hPa sidecar levels used only by build_mpi.py)
# are reported as warnings, not failures.
FRONTEND_LEVELS = {10, 50, 100, 150, 200, 250, 300, 500, 700, 850, 925, 1000}


def _tile_meta(tiles_root: Path, group: str, var: str, meta: dict) -> dict:
    """Per-tile entries from the manifest, or from the var's meta.json when
    the root manifest is slim."""
    if meta.get("tiles"):
        return meta["tiles"]
    mp = tiles_root / group / var / "meta.json"
    return json.loads(mp.read_text()).get("tiles", {}) if mp.exists() else {}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default="data/tiles_per_year")
    ap.add_argument("--min-first-year", type=int, default=1961,
                    help="every per-year var must start at or before this year")
    ap.add_argument("--not-before", default=None,
                    help="YYYY-MM the latest month must be at or after (e.g. the "
                         "currently published latest month)")
    args = ap.parse_args()

    tiles_root = Path(args.root) if Path(args.root).is_absolute() else ROOT / args.root
    manifest = json.loads((tiles_root / "manifest.json").read_text())
    groups = manifest.get("groups", {})
    errors: list[str] = []
    warnings: list[str] = []

    for g in groups:
        if "__add_" in g:
            errors.append(f"bogus group {g!r} in manifest")

    latest = None
    for group, vars_ in groups.items():
        if "__add_" in group:
            continue
        for var, meta in vars_.items():
            yms = meta.get("year_months")
            if not yms:
                continue            # not a per-year var (or derived without tiles)
            first_year = min(y for y, _ in yms)
            if first_year > args.min_first_year:
                errors.append(f"{group}/{var}: starts {first_year}, expected ≤ {args.min_first_year}")
            last = max(tuple(ym) for ym in yms)
            latest = last if latest is None else max(latest, last)
            if meta.get("encoding") != "f16-gz":
                continue
            tiles = _tile_meta(tiles_root, group, var, meta)
            levels = meta.get("levels") or [None]
            for lev in levels:
                missing = [f"{y}-{m:02d}" for y, m in yms
                           if (f"{y}_{m:02d}" if lev is None else f"{lev}_{y}_{m:02d}") not in tiles]
                if not missing:
                    continue
                msg = (f"{group}/{var}" + ("" if lev is None else f" @ {lev} hPa")
                       + f": {len(missing)} month(s) without tile metadata (e.g. {missing[0]})")
                (errors if lev is None or lev in FRONTEND_LEVELS else warnings).append(msg)

    if args.not_before and latest is not None:
        y, m = (int(x) for x in args.not_before.split("-"))
        if latest < (y, m):
            errors.append(f"latest month went backwards: {latest[0]}-{latest[1]:02d} < {args.not_before}")

    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"FAIL  {e}")
    if latest is not None:
        print(f"latest month: {latest[0]}-{latest[1]:02d}")
    print("OK" if not errors else f"{len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
