"""Helpers for incremental month-by-month CDS fetches.

Both download_era5.py and add_pressure_levels.py originally re-fetched a
variable's entire year range whenever its output NetCDF was missing, and
skipped completely when it was present — so once a file was on disk it
never picked up newly-published months. The monthly refresh agent therefore
silently stayed at whatever month was the latest on first-run day.

These helpers let a caller:
  1. Look at an existing NetCDF and ask what its latest time stamp is.
  2. Compute which (year, month) pairs are missing relative to the latest
     month CDS is expected to have published.
  3. Fetch only those months, then concatenate onto the existing file
     in-place (atomic replace via a sibling temp file).
"""
from __future__ import annotations

import logging
import shutil
import tempfile
from datetime import date
from pathlib import Path

import pandas as pd
import xarray as xr

LOG = logging.getLogger("gc-atlas.cds_incremental")

# CDS publishes ERA5T monthly means around the 6-8th of the following month.
# Below this day-of-month, assume only month-before-previous is up; at/after,
# assume the previous month is up. Cheap conservative buffer — if a request
# fails because CDS isn't ready yet, the caller logs and continues.
ERA5T_PUBLISH_CUTOFF_DAY = 8


def rename_time(ds: xr.Dataset) -> xr.Dataset:
    """CDS sometimes emits `valid_time` instead of `time`. Normalise."""
    if "valid_time" in ds.coords and "time" not in ds.coords:
        ds = ds.rename({"valid_time": "time"})
    return ds


def existing_max_time(nc_path: Path) -> pd.Timestamp | None:
    """Latest time stamp in nc_path, or None if file missing / has no time."""
    if not nc_path.exists():
        return None
    try:
        with xr.open_dataset(nc_path) as ds:
            ds = rename_time(ds)
            if "time" not in ds.coords:
                return None
            return pd.Timestamp(ds.time.values.max())
    except Exception as exc:
        LOG.warning("can't read %s for max-time check: %s", nc_path.name, exc)
        return None


def latest_published_month(today: date | None = None) -> tuple[int, int]:
    """Latest (year, month) ERA5T monthly mean expected to be on CDS."""
    today = today or date.today()
    offset = 1 if today.day >= ERA5T_PUBLISH_CUTOFF_DAY else 2
    y, m = today.year, today.month - offset
    while m <= 0:
        m += 12
        y -= 1
    return (y, m)


def missing_months(
    after: pd.Timestamp,
    through: tuple[int, int],
) -> list[tuple[int, int]]:
    """All (year, month) strictly after `after` and at-or-before `through`."""
    end_y, end_m = through
    y, m = after.year, after.month
    m += 1
    if m > 12:
        m, y = 1, y + 1
    out: list[tuple[int, int]] = []
    while (y < end_y) or (y == end_y and m <= end_m):
        out.append((y, m))
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out


def fetch_and_append(
    client,
    dataset: str,
    base_req: dict,
    missing: list[tuple[int, int]],
    out_path: Path,
    log_label: str = "",
) -> int:
    """Pull `missing` months from CDS and merge into out_path.

    base_req must NOT contain `year` or `month` (set per request).
    Returns the number of new time steps actually written.
    On total failure, leaves out_path untouched.
    """
    if not missing:
        return 0

    by_year: dict[int, list[int]] = {}
    for (y, m) in missing:
        by_year.setdefault(y, []).append(m)

    with tempfile.TemporaryDirectory() as tmpd:
        tmpd_path = Path(tmpd)
        tmp_paths: list[Path] = []
        for y, ms in sorted(by_year.items()):
            req = dict(base_req)
            req["year"] = [str(y)]
            req["month"] = [f"{m:02d}" for m in sorted(ms)]
            tp = tmpd_path / f"new_{y}.nc"
            LOG.info("CDS incremental %s year=%d months=%s", log_label, y, sorted(ms))
            try:
                client.retrieve(dataset, req, str(tp))
                tmp_paths.append(tp)
            except Exception as exc:
                LOG.error("CDS incremental fail %s year=%d: %s", log_label, y, exc)

        if not tmp_paths:
            return 0

        pieces = [rename_time(xr.open_dataset(p)).load() for p in tmp_paths]
        if out_path.exists():
            try:
                existing = rename_time(xr.open_dataset(out_path)).load()
                pieces.insert(0, existing)
            except Exception as exc:
                LOG.error("can't read existing %s: %s — aborting append", out_path.name, exc)
                return 0

        merged = xr.concat(pieces, dim="time")
        merged = merged.drop_duplicates("time").sortby("time")

        n_existing = pieces[0].sizes.get("time", 0) if out_path.exists() else 0
        n_after = merged.sizes.get("time", 0)
        n_new = n_after - n_existing

        out_tmp = out_path.with_suffix(out_path.suffix + ".incr.tmp")
        merged.to_netcdf(out_tmp)
        shutil.move(str(out_tmp), str(out_path))
        return max(n_new, 0)
