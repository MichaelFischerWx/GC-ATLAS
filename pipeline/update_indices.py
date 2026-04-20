"""Fetch monthly climate indices from NOAA and emit data/indices.json.

The frontend's composite-builder lets the user pick events where an index
exceeds a threshold in a given month. Five indices ship in the initial
cut; all are monthly values (3-month running means where applicable)
anchored to the central month:

    RONI  — Relative Oceanic Niño Index (ENSO, warming-detrended)
    ONI   — Oceanic Niño Index (ENSO, traditional)
    PNA   — Pacific / North American teleconnection
    NAO   — North Atlantic Oscillation
    AO    — Arctic Oscillation

Two upstream formats are handled:

    PSL .data  (oni.data, pna.data, nao.data, ao.data)
        Header: "<start> <end>"
        Body:   "<year> <jan> <feb> ... <dec>"     12 monthly values
        Missing sentinels: -99.9 and/or -999.0

    CPC RONI.ascii
        Header: "SEAS YR ANOM"
        Body:   "<SEA> <year> <anom>"
        SEA is a 3-letter season code; central month is the middle letter.
        e.g. DJF 1998 → Jan 1998, NDJ 2024 → Dec 2024.

Both formats are normalized to { "<year>": [v_jan, v_feb, ..., v_dec] }
with nulls for missing months. Final JSON is written next to the other
static frontend assets at data/indices.json (small, <200 KB).

Usage:
    python pipeline/update_indices.py
    python pipeline/update_indices.py --out data/indices.json --only oni,nao
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import sys
import urllib.request
from datetime import date
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("update_indices")


# ── source catalogue ─────────────────────────────────────────────────
# NOTE: URLs are public and stable; if NOAA restructures, update here.
SOURCES = {
    "roni": {
        "label": "RONI",
        "long_name": "Relative Oceanic Niño Index",
        "description": "ENSO index with tropical-mean SST anomaly removed — "
                       "isolates the ENSO signal from global warming. "
                       "3-month running mean anchored to central month.",
        "url": "https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt",
        "parser": "cpc_seasonal",
    },
    "oni": {
        "label": "ONI",
        "long_name": "Oceanic Niño Index",
        "description": "SST anomaly in the Niño-3.4 region (5°N–5°S, "
                       "170°W–120°W), 3-month running mean anchored to "
                       "central month. 1991–2020 base period.",
        "url": "https://psl.noaa.gov/data/correlation/oni.data",
        "parser": "psl",
    },
    "pna": {
        "label": "PNA",
        "long_name": "Pacific / North American teleconnection",
        "description": "Winter-dominant wave train over the Pacific–North "
                       "American sector; positive phase = ridge over the "
                       "west coast + trough over the eastern US.",
        "url": "https://psl.noaa.gov/data/correlation/pna.data",
        "parser": "psl",
    },
    "nao": {
        "label": "NAO",
        "long_name": "North Atlantic Oscillation",
        "description": "North Atlantic pressure dipole (Icelandic low vs "
                       "Azores high). Positive = strong westerlies, mild "
                       "NW European winters.",
        "url": "https://psl.noaa.gov/data/correlation/nao.data",
        "parser": "psl",
    },
    "ao": {
        "label": "AO",
        "long_name": "Arctic Oscillation",
        "description": "Hemispheric NH annular mode — leading EOF of "
                       "1000 hPa geopotential N of 20°N. Positive = "
                       "strong polar vortex, cold air bottled up.",
        "url": "https://psl.noaa.gov/data/correlation/ao.data",
        "parser": "psl",
    },
    "amm": {
        "label": "AMM",
        "long_name": "Atlantic Meridional Mode",
        "description": "Cross-equatorial SST + trade-wind mode in the "
                       "tropical Atlantic. Positive = warm N, cool S, "
                       "ITCZ pulled north → stronger W-African monsoon "
                       "and more-active Atlantic hurricane season. "
                       "Chiang & Vimont (2004).",
        "url": "https://psl.noaa.gov/data/timeseries/monthly/AMM/ammsst.data",
        "parser": "psl",
    },
    "pmm": {
        "label": "PMM",
        "long_name": "Pacific Meridional Mode",
        "description": "Subtropical-Pacific analogue of the AMM — "
                       "extratropical stochastic forcing projects onto a "
                       "cross-equatorial SST/trade-wind pattern that can "
                       "seed ENSO through the seasonal footprinting "
                       "mechanism. Chiang & Vimont (2004).",
        "url": "https://psl.noaa.gov/data/timeseries/monthly/PMM/pmmsst.data",
        "parser": "psl",
    },
}


def _is_missing(v: float) -> bool:
    # PSL uses -99.9, some files use -999.0 — anything this negative is
    # a sentinel (no real index sits near that magnitude).
    return (not math.isfinite(v)) or (v <= -50.0)


def parse_psl(text: str) -> dict[str, list[float | None]]:
    """Parse a PSL correlation .data file (year + 12 monthly values)."""
    out: dict[str, list[float | None]] = {}
    lines = [ln for ln in text.splitlines() if ln.strip()]
    # First line is "<start> <end>"; drop it.
    it = iter(lines[1:])
    for ln in it:
        parts = ln.split()
        if len(parts) < 13:
            # Trailing footer (e.g. source tag, end sentinel) — stop parsing.
            break
        try:
            year = int(parts[0])
        except ValueError:
            break
        months: list[float | None] = []
        for s in parts[1:13]:
            try:
                v = float(s)
            except ValueError:
                months.append(None)
                continue
            months.append(None if _is_missing(v) else v)
        out[str(year)] = months
    return out


# Central month (0-indexed) for each of NOAA's 3-letter overlapping-season
# codes. DJF's center is January, NDJ's center is December.
SEASON_CENTER = {
    "DJF":  0, "JFM":  1, "FMA":  2, "MAM":  3,
    "AMJ":  4, "MJJ":  5, "JJA":  6, "JAS":  7,
    "ASO":  8, "SON":  9, "OND": 10, "NDJ": 11,
}


def parse_cpc_seasonal(text: str) -> dict[str, list[float | None]]:
    """Parse CPC RONI.ascii (SEAS YR ANOM). Values anchor to central month."""
    out: dict[str, list[float | None]] = {}
    for ln in text.splitlines():
        parts = ln.split()
        if len(parts) != 3:
            continue
        seas, yr, anom = parts
        if seas == "SEAS":
            continue   # header row
        center = SEASON_CENTER.get(seas)
        if center is None:
            continue
        try:
            year = int(yr)
            v = float(anom)
        except ValueError:
            continue
        row = out.setdefault(str(year), [None] * 12)
        row[center] = None if _is_missing(v) else v
    return out


PARSERS = {"psl": parse_psl, "cpc_seasonal": parse_cpc_seasonal}


def fetch(url: str, timeout: float = 30.0) -> str:
    log.info(f"GET {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "GC-ATLAS/indices"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def build(only: set[str] | None = None) -> dict:
    indices: dict[str, dict] = {}
    for key, meta in SOURCES.items():
        if only and key not in only:
            continue
        try:
            text = fetch(meta["url"])
        except Exception as e:
            log.warning(f"{key}: fetch failed ({e}) — skipping")
            continue
        parser = PARSERS[meta["parser"]]
        values = parser(text)
        years = sorted(int(y) for y in values.keys())
        n_months = sum(1 for y in values for v in values[y] if v is not None)
        log.info(f"{key}: {len(years)} years ({years[0] if years else '—'}–"
                 f"{years[-1] if years else '—'}), {n_months} months")
        indices[key] = {
            "label": meta["label"],
            "long_name": meta["long_name"],
            "description": meta["description"],
            "source": meta["url"],
            "values": values,
        }
    return {
        "updated": date.today().isoformat(),
        "indices": indices,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/indices.json",
                    help="output JSON path (default: data/indices.json)")
    ap.add_argument("--only", default=None,
                    help="comma-separated subset of indices (default: all)")
    args = ap.parse_args()

    only = set(s.strip().lower() for s in args.only.split(",")) if args.only else None
    payload = build(only)
    if not payload["indices"]:
        log.error("no indices fetched — aborting")
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(",", ":")))
    log.info(f"wrote {out}  ({out.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
