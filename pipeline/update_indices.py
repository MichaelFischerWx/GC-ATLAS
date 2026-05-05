"""Fetch monthly climate indices from NOAA and emit data/indices.json.

The frontend's composite-builder lets the user pick events where an index
exceeds a threshold in a given month. All values are monthly (3-month
running means where applicable) anchored to the central month:

    RONI  — Relative Oceanic Niño Index (ENSO, warming-detrended)
    ONI   — Oceanic Niño Index (ENSO, traditional)
    PNA   — Pacific / North American teleconnection
    NAO   — North Atlantic Oscillation
    AO    — Arctic Oscillation
    PDO   — Pacific Decadal Oscillation
    AMM   — Atlantic Meridional Mode
    PMM   — Pacific Meridional Mode
    TNI   — Trans-Niño Index (EP vs CP ENSO discriminator)
    NPGO  — North Pacific Gyre Oscillation (Kuroshio / N-Pacific gyre mode)
    AMO   — Atlantic Multidecadal Oscillation
    QBO   — Quasi-Biennial Oscillation (30-hPa equatorial zonal wind)
    SAM   — Southern Annular Mode (a.k.a. AAO)
    IOD   — Indian Ocean Dipole (Dipole Mode Index)

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
# Per-index metadata. Each entry carries:
#   url        — raw data file (used by the fetcher AND surfaced as a link)
#   parser     — psl | cpc_seasonal
#   provider   — short attribution string ("NOAA CPC", "NOAA PSL")
#   provider_url — landing page for the provider's index portal
#   paper      — short citation label, e.g. "Enfield et al. (2001)"
#   paper_url  — DOI / publisher link to the seminal paper, when available
SOURCES = {
    "roni": {
        "label": "RONI",
        "long_name": "Relative Oceanic Niño Index",
        "description": "ENSO index with tropical-mean SST anomaly removed — "
                       "isolates the ENSO signal from global warming. "
                       "3-month running mean anchored to central month.",
        "url": "https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt",
        "parser": "cpc_seasonal",
        "provider": "NOAA CPC",
        "provider_url": "https://www.cpc.ncep.noaa.gov/data/indices/",
        "paper": "L'Heureux et al. (2024)",
        "paper_url": "https://doi.org/10.1029/2024GL108592",
    },
    "oni": {
        "label": "ONI",
        "long_name": "Oceanic Niño Index",
        "description": "SST anomaly in the Niño-3.4 region (5°N–5°S, "
                       "170°W–120°W), 3-month running mean anchored to "
                       "central month. 1991–2020 base period.",
        "url": "https://psl.noaa.gov/data/correlation/oni.data",
        "parser": "psl",
        "provider": "NOAA PSL",
        "provider_url": "https://psl.noaa.gov/data/climateindices/list/",
        "paper": "NOAA CPC ONI definition",
        "paper_url": "https://origin.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ONI_v5.php",
    },
    "pna": {
        "label": "PNA",
        "long_name": "Pacific / North American teleconnection",
        "description": "Winter-dominant wave train over the Pacific–North "
                       "American sector; positive phase = ridge over the "
                       "west coast + trough over the eastern US.",
        "url": "https://psl.noaa.gov/data/correlation/pna.data",
        "parser": "psl",
        "provider": "NOAA PSL",
        "provider_url": "https://psl.noaa.gov/data/climateindices/list/",
        "paper": "Wallace & Gutzler (1981)",
        "paper_url": "https://doi.org/10.1175/1520-0493(1981)109<0784:TITGHF>2.0.CO;2",
    },
    "nao": {
        "label": "NAO",
        "long_name": "North Atlantic Oscillation",
        "description": "North Atlantic pressure dipole (Icelandic low vs "
                       "Azores high). Positive = strong westerlies, mild "
                       "NW European winters.",
        "url": "https://psl.noaa.gov/data/correlation/nao.data",
        "parser": "psl",
        "provider": "NOAA PSL",
        "provider_url": "https://psl.noaa.gov/data/climateindices/list/",
        "paper": "Hurrell (1995)",
        "paper_url": "https://doi.org/10.1126/science.269.5224.676",
    },
    "ao": {
        "label": "AO",
        "long_name": "Arctic Oscillation",
        "description": "Hemispheric NH annular mode — leading EOF of "
                       "1000 hPa geopotential N of 20°N. Positive = "
                       "strong polar vortex, cold air bottled up.",
        "url": "https://psl.noaa.gov/data/correlation/ao.data",
        "parser": "psl",
        "provider": "NOAA PSL",
        "provider_url": "https://psl.noaa.gov/data/climateindices/list/",
        "paper": "Thompson & Wallace (1998)",
        "paper_url": "https://doi.org/10.1029/98GL00950",
    },
    "pdo": {
        "label": "PDO",
        "long_name": "Pacific Decadal Oscillation",
        "description": "Leading EOF of monthly N-Pacific SST anomalies "
                       "(N of 20°N). Decadal-scale: sustained warm or "
                       "cool phases lasting 20-30 years that modulate "
                       "ENSO teleconnections, US drought / fishery "
                       "regimes. Mantua et al. (1997).",
        "url": "https://psl.noaa.gov/data/correlation/pdo.data",
        "parser": "psl",
        "provider": "NOAA PSL",
        "provider_url": "https://psl.noaa.gov/data/climateindices/list/",
        "paper": "Mantua et al. (1997)",
        "paper_url": "https://doi.org/10.1175/1520-0477(1997)078<1069:APICOW>2.0.CO;2",
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
        "provider": "NOAA PSL",
        "provider_url": "https://psl.noaa.gov/data/timeseries/monthly/AMM/",
        "paper": "Chiang & Vimont (2004)",
        "paper_url": "https://doi.org/10.1175/JCLI-3324.1",
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
        "provider": "NOAA PSL",
        "provider_url": "https://psl.noaa.gov/data/timeseries/monthly/PMM/",
        "paper": "Chiang & Vimont (2004)",
        "paper_url": "https://doi.org/10.1175/JCLI-3324.1",
    },
    "tni": {
        "label": "TNI",
        "long_name": "Trans-Niño Index",
        "description": "Standardized Niño-1+2 SSTa minus standardized "
                       "Niño-4 SSTa — captures the east–central tropical "
                       "Pacific SST gradient. Distinguishes Eastern-Pacific "
                       "(EP) from Central-Pacific (CP, 'Modoki') ENSO "
                       "events independent of overall warm/cold state. "
                       "Trenberth & Stepaniak (2001).",
        "url": "https://psl.noaa.gov/data/correlation/tni.data",
        "parser": "psl",
        "provider": "NOAA PSL",
        "provider_url": "https://psl.noaa.gov/data/climateindices/list/#TNI",
        "paper": "Trenberth & Stepaniak (2001)",
        "paper_url": "https://doi.org/10.1175/1520-0442(2001)014<1697:LIOENO>2.0.CO;2",
    },
    "npgo": {
        "label": "NPGO",
        "long_name": "North Pacific Gyre Oscillation",
        "description": "Second EOF of N-Pacific SSH (and SST) — the "
                       "low-frequency gyre-circulation mode that pairs "
                       "with the PDO. Tracks Kuroshio Extension shifts, "
                       "California Current nutrient supply, and "
                       "ecosystem regime change. Di Lorenzo et al. (2008).",
        "url": "https://psl.noaa.gov/data/correlation/npgo.data",
        "parser": "psl",
        "provider": "NOAA PSL",
        "provider_url": "https://www.npgo.org/",
        "paper": "Di Lorenzo et al. (2008)",
        "paper_url": "https://doi.org/10.1029/2007GL032838",
    },
    "amo": {
        "label": "AMO",
        "long_name": "Atlantic Multidecadal Oscillation",
        "description": "Detrended N-Atlantic SST anomaly (Kaplan SST V2, "
                       "unsmoothed). The dominant ~60-yr Atlantic SST "
                       "mode — Atlantic hurricane activity, Sahel rainfall, "
                       "and N-American summer drought all track its phase. "
                       "Enfield et al. (2001).",
        "url": "https://psl.noaa.gov/data/correlation/amon.us.data",
        "parser": "psl",
        "provider": "NOAA PSL",
        "provider_url": "https://psl.noaa.gov/data/timeseries/AMO/",
        "paper": "Enfield et al. (2001)",
        "paper_url": "https://doi.org/10.1029/2000GL012745",
    },
    "qbo": {
        "label": "QBO",
        "long_name": "Quasi-Biennial Oscillation",
        "description": "30-hPa equatorial zonal-mean zonal wind (m/s). "
                       "Stratospheric ~28-month easterly/westerly cycle "
                       "that modulates Atlantic hurricane shear "
                       "environment (Gray 1984) and tropical convection.",
        "url": "https://psl.noaa.gov/data/correlation/qbo.data",
        "parser": "psl",
        "provider": "NOAA PSL",
        "provider_url": "https://psl.noaa.gov/data/climateindices/list/",
        "paper": "Baldwin et al. (2001)",
        "paper_url": "https://doi.org/10.1029/1999RG000073",
    },
    "sam": {
        "label": "SAM",
        "long_name": "Southern Annular Mode (Antarctic Oscillation)",
        "description": "SH counterpart to the AO — leading EOF of "
                       "700-hPa height S of 20°S. Positive = strong "
                       "polar vortex, poleward-shifted SH westerly jet. "
                       "Modulates SH storm tracks and Antarctic sea-ice. "
                       "Sometimes called AAO.",
        "url": "https://psl.noaa.gov/data/correlation/aao.data",
        "parser": "psl",
        "provider": "NOAA CPC",
        "provider_url": "https://www.cpc.ncep.noaa.gov/products/precip/CWlink/daily_ao_index/aao/aao.shtml",
        "paper": "Thompson & Wallace (2000)",
        "paper_url": "https://doi.org/10.1175/1520-0442(2000)013<1000:AMITEC>2.0.CO;2",
    },
    "iod": {
        "label": "IOD",
        "long_name": "Indian Ocean Dipole (Dipole Mode Index)",
        "description": "Tropical Indian Ocean SST gradient: W (50–70°E, "
                       "10°S–10°N) minus E (90–110°E, 10°S–0°). Positive "
                       "IOD = warm W / cool E → E-African flooding, "
                       "Indonesian drought, modulates IO + W. Pacific "
                       "TC season. Saji et al. (1999). HadISST source.",
        "url": "https://psl.noaa.gov/data/timeseries/month/data/dmi.had.long.data",
        "parser": "psl",
        "provider": "NOAA PSL (Met Office HadISST)",
        "provider_url": "https://psl.noaa.gov/gcos_wgsp/Timeseries/DMI/",
        "paper": "Saji et al. (1999)",
        "paper_url": "https://doi.org/10.1038/43854",
    },
}

# Optional fields propagated from SOURCES into each index entry in the
# output JSON. Centralised so you don't have to remember to update build()
# when the SOURCES schema grows.
_INDEX_META_FIELDS = ("label", "long_name", "description",
                      "provider", "provider_url", "paper", "paper_url")


def _is_missing(v: float, sentinels: tuple[float, ...]) -> bool:
    if not math.isfinite(v):
        return True
    # The PSL footer line declares this file's missing-value indicator
    # explicitly (-9.90, -99.9, -999.0 — varies by file). Match against
    # all known sentinels with float tolerance.
    return any(abs(v - s) < 0.05 for s in sentinels)


def parse_psl(text: str) -> dict[str, list[float | None]]:
    """Parse a PSL correlation .data file (year + 12 monthly values).
    Footer line carries the missing-value sentinel for this file."""
    out: dict[str, list[float | None]] = {}
    lines = [ln for ln in text.splitlines() if ln.strip()]
    # First line: "<start> <end>". Anything after the data block typically
    # starts with the missing-value sentinel (a single-number line) and
    # may then carry a description / source URL.
    sentinels: list[float] = [-99.9, -999.0, -9.9]   # sane defaults
    data_lines: list[str] = []
    for ln in lines[1:]:
        parts = ln.split()
        if len(parts) >= 13:
            try:
                int(parts[0])
                data_lines.append(ln)
                continue
            except ValueError:
                pass
        # Footer territory — try parsing as a lone sentinel value.
        if len(parts) == 1:
            try:
                sentinels.append(float(parts[0]))
            except ValueError:
                pass
    sentinels_t = tuple(sentinels)
    for ln in data_lines:
        parts = ln.split()
        try:
            year = int(parts[0])
        except ValueError:
            continue
        months: list[float | None] = []
        for s in parts[1:13]:
            try:
                v = float(s)
            except ValueError:
                months.append(None)
                continue
            months.append(None if _is_missing(v, sentinels_t) else v)
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
        # CPC RONI uses -99.9; also catch -9.9 / -999.0 for safety.
        row[center] = None if _is_missing(v, (-99.9, -9.9, -999.0)) else v
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
        # Pull through every metadata field defined in _INDEX_META_FIELDS so
        # adding a new field to SOURCES (provider, paper_url, ...) shows up
        # in the JSON without having to touch this builder.
        entry = {k: meta[k] for k in _INDEX_META_FIELDS if k in meta}
        entry["source"] = meta["url"]    # back-compat alias for old frontend
        entry["values"] = values
        indices[key] = entry
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
