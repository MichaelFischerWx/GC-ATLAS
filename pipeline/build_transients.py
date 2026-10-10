"""Transient-eddy covariances from WeatherBench2's 6-hourly ERA5 → GC-ATLAS tiles.

Every eddy diagnostic in GC-ATLAS (EP flux, Lorenz cycle, M/Q/H budgets) is
stationary-only, because the tiles are monthly means. This script supplies
the transient part from the 1° 6-hourly ERA5 that WeatherBench2 hosts on a
public bucket (read anonymously — nothing is downloaded first):

    gs://weatherbench2/datasets/era5/
        1959-2023_01_10-6h-360x181_equiangular_with_poles_conservative.zarr

Definitions
-----------
For each (year, month), over its N 6-hourly samples (00/06/12/18 UTC):

    covariance   a'b' = mean(ab) − mean(a)·mean(b)          (each gridpoint)
    diurnal part       = ¼ Σ_h (ā_h − ā)(b̄_h − b̄)          ā_h = month mean at hour h

"Transient" is therefore sub-monthly: departures from that month's own mean,
the counterpart of the stationary eddies GC-ATLAS already computes from
monthly-mean fields (Li et al. 2007's "monthly evaluation"). The mean diurnal
cycle is included, as in the classical statistics (Peixoto & Oort 1992); it
matters only for ω-fluxes near the surface (ω'T' ~30 % at 1000 hPa, 2–7 %
from 850 hPa up) and is stored separately (dcov_*), so a diurnal-free
variant (tiles --diurnal remove) needs no re-read.
Climatology tiles average the monthly covariances over a period's years by
calendar month. The inter-annual covariance of the monthly means falls in
neither term when the stationary eddies come from the period-mean fields;
`tiles` reports its size but doesn't tile it.

Fields (tile key: pair — all SI as stored; Φ = geopotential, ω in Pa s⁻¹):
    upvp u'v'   vptp v'T'   vpqp v'q'   vpzp v'Φ'      (meridional fluxes)
    upwp u'ω'   wptp ω'T'   wpqp ω'q'   wpzp ω'Φ'      (vertical fluxes)
    upup u'²    vpvp v'²    tptp T'²    zpzp Φ'²       (variances)
  EKE = ½(upup + vpvp); MSE fluxes v'h' = c_p·vptp + vpzp + L_v·vpqp (same for ω).
  Storm tracks, 2–8-day Lanczos band-pass (121 weights on the 6-hourly series):
    z500bp Φ'² at 500 hPa    v850bp v'² at 850 hPa    vt850bp v'T' at 850 hPa
  agfrac: monthly mean of WB2's `above_ground` (fraction of the 1° cell and of
    the month the level lies above the surface — Boer's (1982) β).
Levels are WB2's 13: 50 100 150 200 250 300 400 500 600 700 850 925 1000 hPa.
There is no 10 hPa (GC-ATLAS's top level); the frontend has to treat the
transient terms there as missing — see docs/ROADMAP.md.

Steps
-----
1. moments — one year per worker process: stream WB2 in whole-day reads
   (all six fields + above_ground, prefetched on a thread pool), accumulate
   per-month sums, and write data/transients/moments/YYYY-MM.nc (monthly
   means, covariances, diurnal parts, agfrac; float32, GC-ATLAS orientation).
   The band-pass needs ±15 days of z, v, T around each year, so a year also
   reads those halo days and then writes data/transients/bandpass/YYYY-MM.nc.
   Restartable: a year whose files all exist is skipped.
2. tiles — average the moments by calendar month over a period (climatology
   + std_ tiles = inter-annual σ of the monthly covariance), or copy each
   (year, month) out (--per-year); encode with compress_tiles.compress_var_dir
   (f16-gz, per-tile vmin/vmax); add a "transients" group to the tree's
   manifest.json without touching the other groups.

Tree layout
-----------
    data/tiles/transients/<key>/              1991–2020 climatology (default tree)
    data/tiles_<A>_<B>/transients/<key>/      other windows — WB2 spans
                                              1959–2022, so every GC-ATLAS
                                              window except 1996–2025
    data/tiles_per_year/transients/<key>/     per-(year, month), only for a span
                                              starting ≤ 1961: the monthly
                                              refresh's validate_manifest.py
                                              fails any per-year var that starts
                                              later, which stops publishing.
Tile names follow build_tiles.py: <level>_<MM>.bin.gz, std_<level>_<MM>.bin.gz,
<level>_<YYYY>_<MM>.bin.gz; single-level <MM>.bin.gz / <YYYY>_<MM>.bin.gz.

Cost: 63.7 MB of compressed reads per day (six fields + above_ground) plus
the band-pass halos → ~24 GB per year: 1991–2020 ≈ 0.72 TB, 1961–2022 ≈
1.50 TB. Moments are ~80 MB per month on disk; tiles ~110 KB each (≈18 MB
per per-year month, ≈0.4 GB per climatology window). docs/ROADMAP.md has the
VM run plan — and why a VM must not upload manifests.

Usage:
    python pipeline/build_transients.py bench --days 4                  # read throughput
    python pipeline/build_transients.py moments --start 2000-01 --end 2000-01
    python pipeline/build_transients.py check --months 1999-12,2000-01,2000-02
    python pipeline/build_transients.py moments --start 1961-01 --end 2022-12 --workers 12
    python pipeline/build_transients.py tiles --period 1991-2020        # → data/tiles/transients
    python pipeline/build_transients.py tiles --per-year                # → data/tiles_per_year/transients
    python pipeline/build_transients.py manifest --root data/tiles      # re-add the group locally
"""
from __future__ import annotations

import argparse
import gzip
import json
import logging
import multiprocessing as mp
import os
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

LOG = logging.getLogger("gc-atlas.build_transients")
ROOT = Path(__file__).resolve().parent.parent
WB2_URL = ("gs://weatherbench2/datasets/era5/"
           "1959-2023_01_10-6h-360x181_equiangular_with_poles_conservative.zarr")
WORK_DIR = ROOT / "data" / "transients"
GROUP = "transients"

# WB2 time is "hours since 1959-01-01", 6-hourly from index 0, one day per
# chunk — so index i is 00 UTC exactly when i % 4 == 0.
EPOCH = np.datetime64("1959-01-01T00", "h")
STEPS_PER_DAY = 4

SRC = {                      # GC-ATLAS short name → WB2 variable
    "u": "u_component_of_wind",
    "v": "v_component_of_wind",
    "w": "vertical_velocity",
    "t": "temperature",
    "z": "geopotential",
    "q": "specific_humidity",
}
FIELDS = tuple(SRC)
FIELD_UNITS = {"u": "m s**-1", "v": "m s**-1", "w": "Pa s**-1",
               "t": "K", "z": "m**2 s**-2", "q": "kg kg**-1"}
READ_ALL = FIELDS + ("ag",)  # "ag" = WB2 above_ground

PAIRS = {   # tile key: (a, b, units, long name)
    "upvp": ("u", "v", "m**2 s**-2", "transient eddy momentum flux u'v'"),
    "vptp": ("v", "t", "K m s**-1", "transient eddy heat flux v'T'"),
    "vpqp": ("v", "q", "kg kg**-1 m s**-1", "transient eddy moisture flux v'q'"),
    "vpzp": ("v", "z", "m**3 s**-3", "transient eddy geopotential flux v'Phi'"),
    "upwp": ("u", "w", "m Pa s**-2", "transient vertical eddy momentum flux u'omega'"),
    "wptp": ("w", "t", "K Pa s**-1", "transient vertical eddy heat flux omega'T'"),
    "wpqp": ("w", "q", "kg kg**-1 Pa s**-1", "transient vertical eddy moisture flux omega'q'"),
    "wpzp": ("w", "z", "m**2 Pa s**-3", "transient vertical eddy geopotential flux omega'Phi'"),
    "upup": ("u", "u", "m**2 s**-2", "transient zonal-wind variance u'^2"),
    "vpvp": ("v", "v", "m**2 s**-2", "transient meridional-wind variance v'^2"),
    "tptp": ("t", "t", "K**2", "transient temperature variance T'^2"),
    "zpzp": ("z", "z", "m**4 s**-4", "transient geopotential variance Phi'^2"),
}

# 2–8-day band-pass for storm tracks (Blackmon 1976 used 2.5–6 d on daily
# z500). Lanczos (Duchon 1979) on the 6-hourly series; its half-width is the
# halo each year reads on either side, so interior months see only real data.
BAND_DAYS = (2.0, 8.0)
BP_HALF_DAYS = 15
BP_FIELDS = (("z", 500), ("v", 850), ("t", 850))
BP_READ = ("z", "v", "t")
BP_STATS = {   # tile key: (field a, field b, level hPa, units, long name)
    "z500bp": (("z", 500), ("z", 500), 500, "m**4 s**-4",
               "2-8-day band-passed geopotential variance Phi'^2 at 500 hPa"),
    "v850bp": (("v", 850), ("v", 850), 850, "m**2 s**-2",
               "2-8-day band-passed meridional-wind variance v'^2 at 850 hPa"),
    "vt850bp": (("v", 850), ("t", 850), 850, "K m s**-1",
                "2-8-day band-passed eddy heat flux v'T' at 850 hPa"),
}
AGFRAC = ("agfrac", "1", "fraction of the cell and month above ground (WB2 above_ground)")

DEFINITION = ("monthly mean of 6-hourly products minus the product of the monthly "
              "means (sub-monthly transients; mean diurnal cycle {diurnal})")

# GC-ATLAS grid: lat 90 → −90, lon −180 → 179 (build_tiles.py convention).
LATS = np.arange(90.0, -90.5, -1.0)
LONS = np.arange(-180.0, 180.0, 1.0)


# ── time helpers ──────────────────────────────────────────────────────────

def month_start(year: int, month: int) -> np.datetime64:
    return np.datetime64(f"{year:04d}-{month:02d}-01T00", "h")


def next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


def prev_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)


def tindex(t: np.datetime64) -> int:
    """WB2 time index of a 6-hourly time."""
    return int((t - EPOCH) // np.timedelta64(6, "h"))


def month_bounds(year: int, month: int) -> tuple[int, int]:
    """[i0, i1) WB2 time indices covering the month."""
    return tindex(month_start(year, month)), tindex(month_start(*next_month(year, month)))


def parse_ym(s: str) -> tuple[int, int]:
    y, m = (int(x) for x in s.split("-"))
    if not 1 <= m <= 12:
        raise ValueError(f"bad month in {s!r}")
    return y, m


def month_range(start: str, end: str) -> list[tuple[int, int]]:
    ym, last = parse_ym(start), parse_ym(end)
    out = []
    while ym <= last:
        out.append(ym)
        ym = next_month(*ym)
    return out


def moments_path(work: Path, y: int, m: int) -> Path:
    return work / "moments" / f"{y:04d}-{m:02d}.nc"


def bandpass_path(work: Path, y: int, m: int) -> Path:
    return work / "bandpass" / f"{y:04d}-{m:02d}.nc"


# ── WB2 reader ────────────────────────────────────────────────────────────

class WB2:
    """Anonymous reader for the WB2 store. Each field read runs on a thread
    pool, and each read fetches its chunks concurrently (zarr FSStore
    getitems → gcsfs), so a whole-day read of all fields is ~30 parallel
    GETs. Counts compressed bytes for the MB/s logs."""

    def __init__(self, url: str, threads: int):
        import gcsfs
        import zarr

        class CountingFSStore(zarr.storage.FSStore):
            def __init__(self, *a, **kw):
                super().__init__(*a, **kw)
                self.nbytes = 0
                self._lock = threading.Lock()

            def getitems(self, keys, *, contexts):
                out = super().getitems(keys, contexts=contexts)
                n = sum(len(v) for v in out.values())
                with self._lock:
                    self.nbytes += n
                return out

        fs = gcsfs.GCSFileSystem(token="anon")
        self.store = CountingFSStore(url.removeprefix("gs://"), fs=fs, mode="r")
        g = zarr.open_consolidated(self.store, mode="r")
        self.arrays = {k: g[v] for k, v in SRC.items()}
        self.arrays["ag"] = g["above_ground"]
        self.levels = [int(p) for p in g["level"][:]]
        lat, lon, hours = g["latitude"][:], g["longitude"][:], g["time"][:]
        # to_tile_layout() and the time arithmetic assume this layout; fail
        # loudly rather than write mis-oriented tiles if the store changes.
        if not (len(lat) == 181 and lat[0] == -90 and lat[-1] == 90
                and len(lon) == 360 and lon[0] == 0 and lon[-1] == 359):
            raise RuntimeError("unexpected WB2 lat/lon layout")
        if hours[0] != 0 or not np.all(np.diff(hours) == 6):
            raise RuntimeError("WB2 time axis is not 6-hourly from 1959-01-01T00")
        for name, a in self.arrays.items():
            if a.chunks[0] != STEPS_PER_DAY or a.shape[-2:] != (360, 181):
                raise RuntimeError(f"unexpected chunking/shape for {name}: {a.chunks} {a.shape}")
        self.nt = len(hours)
        self.pool = ThreadPoolExecutor(threads)

    def last_full_month(self) -> tuple[int, int]:
        """Latest month the store covers completely (2022-12: it ends 2023-01-10)."""
        t_end = EPOCH + np.timedelta64(6 * self.nt, "h")          # exclusive
        ym = parse_ym(str(t_end.astype("datetime64[M]")))
        while month_start(*next_month(*ym)) > t_end:
            ym = prev_month(*ym)
        return ym

    def submit(self, names, i0: int, i1: int) -> dict:
        return {n: self.pool.submit(self.arrays[n].__getitem__, slice(i0, i1)) for n in names}

    def close(self) -> None:
        self.pool.shutdown(wait=True)


# ── accumulation ──────────────────────────────────────────────────────────

def to_tile_layout(a: np.ndarray) -> np.ndarray:
    """WB2 (…, lon 0→359, lat −90→90) → GC-ATLAS (…, lat 90→−90, lon −180→179)."""
    a = np.swapaxes(a, -1, -2)[..., ::-1, :]
    return np.ascontiguousarray(np.roll(a, 180, axis=-1), dtype=np.float32)


class MonthMoments:
    """Running sums for one (year, month) on WB2's native (level, lon, lat)
    grid. Samples are shifted by the month's first-read mean before the
    products are formed, so mean(ab) − mean(a)·mean(b) doesn't cancel
    catastrophically (Φ² ~ 1e9 m⁴ s⁻⁴ vs tropical Φ'² ~ 1e4). Products of
    the shifted float32 samples are summed per read (≤ 32 samples) and
    accumulated in float64."""

    def __init__(self):
        self.shift: dict | None = None
        self.n = 0

    def add(self, data: dict) -> None:
        """`data`: READ_ALL arrays (nt, level, lon, lat), nt whole days
        starting at 00 UTC. Shifts the field arrays in place."""
        nt = data["u"].shape[0]
        if nt % STEPS_PER_DAY:
            raise ValueError("reads must cover whole days")
        if self.shift is None:
            self.shift = {v: data[v].mean(axis=0) for v in FIELDS}
            size = self.shift["u"].size
            self.hsum = {v: np.zeros((STEPS_PER_DAY, size)) for v in FIELDS}
            self.psum = {k: np.zeros(size) for k in PAIRS}
            self.agsum = np.zeros(size)
        x = {}
        for v in FIELDS:
            a = data[v]
            a -= self.shift[v]
            x[v] = a.reshape(nt, -1)
            self.hsum[v] += x[v].reshape(nt // STEPS_PER_DAY, STEPS_PER_DAY, -1).sum(axis=0, dtype=np.float64)
        for k, (a, b, *_) in PAIRS.items():
            self.psum[k] += np.einsum("tp,tp->p", x[a], x[b])
        self.agsum += data["ag"].reshape(nt, -1).sum(axis=0, dtype=np.float64)
        self.n += nt

    def finalize(self) -> dict[str, np.ndarray]:
        """Monthly means, covariances and diurnal parts in tile layout
        (level, lat, lon), float32."""
        n = self.n
        per_hour = n // STEPS_PER_DAY
        mean, hdev, out = {}, {}, {}
        for v in FIELDS:
            s = self.hsum[v]
            mean[v] = s.sum(axis=0) / n
            hdev[v] = s / per_hour - mean[v]
            out[f"mean_{v}"] = mean[v] + self.shift[v].reshape(-1)
        for k, (a, b, *_) in PAIRS.items():
            out[f"cov_{k}"] = self.psum[k] / n - mean[a] * mean[b]
            out[f"dcov_{k}"] = (hdev[a] * hdev[b]).mean(axis=0)
        out["agfrac"] = self.agsum / n
        shape = self.shift["u"].shape
        return {k: to_tile_layout(v.reshape(shape)) for k, v in out.items()}


def lanczos_bandpass(half_width: int, f_lo: float, f_hi: float) -> np.ndarray:
    """2·half_width+1 Lanczos band-pass weights (Duchon 1979); f in cycles
    per sample."""
    k = np.arange(1, half_width + 1)
    w = (np.sin(2 * np.pi * f_hi * k) - np.sin(2 * np.pi * f_lo * k)) / (np.pi * k)
    w *= np.sinc(k / (half_width + 1))           # σ factors: sin(πk/n)/(πk/n)
    return np.concatenate([w[::-1], [2 * (f_hi - f_lo)], w])


def filter_response(weights: np.ndarray, period_samples: float) -> float:
    m = len(weights) // 2
    k = np.arange(-m, m + 1)
    return float(np.sum(weights * np.cos(2 * np.pi * k / period_samples)))


def bandpass_weights() -> np.ndarray:
    lo, hi = BAND_DAYS
    return lanczos_bandpass(BP_HALF_DAYS * STEPS_PER_DAY,
                            1 / (hi * STEPS_PER_DAY), 1 / (lo * STEPS_PER_DAY))


# ── NetCDF I/O ────────────────────────────────────────────────────────────

def _var_attrs(name: str) -> dict:
    if name.startswith("mean_"):
        return {"units": FIELD_UNITS[name[5:]], "long_name": f"monthly mean {SRC[name[5:]]}"}
    if name.startswith(("cov_", "dcov_")):
        k = name.split("_", 1)[1]
        part = "" if name.startswith("cov_") else " (mean diurnal-cycle part)"
        return {"units": PAIRS[k][2], "long_name": PAIRS[k][3] + part}
    if name in BP_STATS:
        return {"units": BP_STATS[name][3], "long_name": BP_STATS[name][4]}
    if name == "agfrac":
        return {"units": AGFRAC[1], "long_name": AGFRAC[2]}
    return {}


def write_nc(path: Path, fields: dict[str, np.ndarray], levels: list[int], attrs: dict) -> None:
    """Write (level, lat, lon) / (lat, lon) float32 fields atomically."""
    import xarray as xr
    data_vars = {}
    for k, a in fields.items():
        dims = ("level", "latitude", "longitude") if a.ndim == 3 else ("latitude", "longitude")
        data_vars[k] = (dims, a, _var_attrs(k))
    coords = {"latitude": LATS, "longitude": LONS}
    if any(a.ndim == 3 for a in fields.values()):
        coords["level"] = np.asarray(levels, dtype=np.int32)
    ds = xr.Dataset(data_vars, coords=coords, attrs=attrs)
    enc = {k: {"zlib": True, "complevel": 1, "shuffle": True} for k in fields}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    ds.to_netcdf(tmp, encoding=enc)
    os.replace(tmp, path)


def read_nc(path: Path, names=None) -> tuple[dict[str, np.ndarray], dict, list[int]]:
    import xarray as xr
    with xr.open_dataset(path) as ds:
        keep = list(ds.data_vars) if names is None else [n for n in names if n in ds]
        out = {k: ds[k].values.astype(np.float64) for k in keep}
        levels = [int(p) for p in ds["level"].values] if "level" in ds.coords else []
        return out, dict(ds.attrs), levels


# ── step 1: moments ───────────────────────────────────────────────────────

def _segments(i_lo: int, i_hi: int, step: int) -> list[tuple[int, int]]:
    out, i = [], i_lo
    while i < i_hi:
        out.append((i, min(i_hi, i + step)))
        i += step
    return out


def process_year(year: int, months: list[int], cfg: dict) -> dict:
    """Moments (and band-pass statistics) for `months` of `year`. Runs in a
    worker process; returns a small summary for the driver's log."""
    work = Path(cfg["work"])
    force = cfg["force"]
    need_mom = {m: force or not moments_path(work, year, m).exists() for m in months}
    need_bp = cfg["bandpass"] and any(force or not bandpass_path(work, year, m).exists()
                                      for m in months)
    if not any(need_mom.values()) and not need_bp:
        return {"year": year, "skipped": True, "bytes": 0, "seconds": 0.0}

    t_year = time.time()
    rd = WB2(cfg["url"], cfg["threads"])
    try:
        nbytes = _stream_year(rd, year, months, need_mom, need_bp, cfg)
    finally:
        rd.close()
    return {"year": year, "skipped": False, "bytes": nbytes, "seconds": time.time() - t_year}


def _stream_year(rd: WB2, year: int, months: list[int], need_mom: dict, need_bp: bool,
                 cfg: dict) -> int:
    work = Path(cfg["work"])
    lev_index = {p: k for k, p in enumerate(rd.levels)}
    last = rd.last_full_month()
    if (year, months[-1]) > last:
        raise ValueError(f"{year}-{months[-1]:02d} is past WB2's last full month "
                         f"{last[0]}-{last[1]:02d}")
    step = cfg["days_per_read"] * STEPS_PER_DAY
    bounds = {m: month_bounds(year, m) for m in months}
    i_lo, i_hi = bounds[months[0]][0], bounds[months[-1]][1]

    # Read plan: (i0, i1, fields, month to accumulate or None).
    plan: list[tuple[int, int, tuple, int | None]] = []
    halo = BP_HALF_DAYS * STEPS_PER_DAY if need_bp else 0
    b_lo, b_hi = max(0, i_lo - halo), min(rd.nt, i_hi + halo)
    plan += [(a, b, BP_READ, None) for a, b in _segments(b_lo, i_lo, step)]
    for m in months:
        if need_mom[m]:
            plan += [(a, b, READ_ALL, m) for a, b in _segments(*bounds[m], step)]
        elif need_bp:
            plan += [(a, b, BP_READ, None) for a, b in _segments(*bounds[m], step)]
    plan += [(a, b, BP_READ, None) for a, b in _segments(i_hi, b_hi, step)]

    series = ({f: np.empty((b_hi - b_lo, 360, 181), np.float32) for f in BP_FIELDS}
              if need_bp else None)
    acc, t_month, b_month = None, 0.0, 0
    pending = rd.submit(plan[0][2], plan[0][0], plan[0][1])
    for k, (i0, i1, names, m) in enumerate(plan):
        data = {n: f.result() for n, f in pending.items()}
        if k + 1 < len(plan):
            nxt = plan[k + 1]
            pending = rd.submit(nxt[2], nxt[0], nxt[1])
        if series is not None:
            for f in BP_FIELDS:
                series[f][i0 - b_lo:i1 - b_lo] = data[f[0]][:, lev_index[f[1]]]
        if m is None:
            continue
        if acc is None:
            acc, t_month, b_month = MonthMoments(), time.time(), rd.store.nbytes
        acc.add(data)
        if i1 == bounds[m][1]:
            fields = acc.finalize()
            acc = None
            out = moments_path(work, year, m)
            write_nc(out, fields, rd.levels, {
                "year": year, "month": m, "n_samples": i1 - bounds[m][0],
                "source": cfg["url"],
                "definition": DEFINITION.format(diurnal="included in cov_*, also given alone in dcov_*"),
            })
            dt = time.time() - t_month
            nb = rd.store.nbytes - b_month
            LOG.info("%04d-%02d  moments  %.2f GB in %5.1f s (%5.1f MB/s)  → %s",
                     year, m, nb / 1e9, dt, nb / 1e6 / max(dt, 1e-9), _rel(out))

    if series is not None:
        _write_bandpass(work, year, months, bounds, series, b_lo, i_lo - b_lo, b_hi - i_hi, cfg)
    return rd.store.nbytes


def _write_bandpass(work, year, months, bounds, series, b_lo, halo_before, halo_after, cfg) -> None:
    """2–8-day statistics per month from the year's filtered series."""
    from scipy.ndimage import correlate1d
    w = bandpass_weights().astype(np.float64)
    # 'reflect' only matters at WB2's ends (1959-01, 2023-01-10), where the
    # halo is short; interior months see real data across the whole window.
    filt = {}
    for f in BP_FIELDS:
        filt[f] = correlate1d(series.pop(f), w, axis=0, mode="reflect")
    for m in months:
        s0, s1 = (i - b_lo for i in bounds[m])
        fields = {}
        for key, (fa, fb, *_rest) in BP_STATS.items():
            a = filt[fa][s0:s1].astype(np.float64)
            b = a if fb == fa else filt[fb][s0:s1].astype(np.float64)
            cov = (a * b).mean(axis=0) - a.mean(axis=0) * b.mean(axis=0)
            fields[key] = to_tile_layout(cov)
        out = bandpass_path(work, year, m)
        full = (halo_before >= BP_HALF_DAYS * STEPS_PER_DAY or m != months[0]) and \
               (halo_after >= BP_HALF_DAYS * STEPS_PER_DAY or m != months[-1])
        write_nc(out, fields, [], {
            "year": year, "month": m, "source": cfg["url"],
            "band_days": list(BAND_DAYS),
            "filter": f"Lanczos band-pass, {len(w)} weights on the 6-hourly series",
            "full_filter_window": int(full),
        })
        LOG.info("%04d-%02d  band-pass → %s%s", year, m, _rel(out),
                 "" if full else "  (short halo at WB2's end: reflected)")


def _init_worker(level: int) -> None:
    logging.basicConfig(level=level, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")


def cmd_moments(args) -> int:
    work = _abs(args.work)
    months = month_range(args.start, args.end)
    by_year: dict[int, list[int]] = {}
    for y, m in months:
        by_year.setdefault(y, []).append(m)
    cfg = {"url": args.url, "threads": args.threads, "days_per_read": args.days_per_read,
           "bandpass": not args.no_bandpass, "work": str(work), "force": args.force}
    LOG.info("moments  %s → %s  (%d months, %d year(s), %d worker(s), %d threads each)",
             args.start, args.end, len(months), len(by_year), args.workers, args.threads)
    w = bandpass_weights()
    LOG.info("band-pass response: %s", "  ".join(
        f"{p:g} d {filter_response(w, p * STEPS_PER_DAY):+.2f}" for p in (1, 1.5, 2, 3, 5, 8, 12, 20, 30)))
    t0 = time.time()
    total, failed = 0, []
    if args.workers <= 1:
        for y, ms in by_year.items():
            r = process_year(y, ms, cfg)
            total += r["bytes"]
    else:
        ctx = mp.get_context("spawn")        # gcsfs/gRPC threads don't survive fork
        with ProcessPoolExecutor(args.workers, mp_context=ctx, initializer=_init_worker,
                                 initargs=(LOG.getEffectiveLevel(),)) as ex:
            futs = {ex.submit(process_year, y, ms, cfg): y for y, ms in by_year.items()}
            for f in as_completed(futs):
                y = futs[f]
                try:
                    r = f.result()
                except Exception as exc:          # keep going; report at the end
                    LOG.error("FAIL  %d: %r", y, exc)
                    failed.append(y)
                    continue
                total += r["bytes"]
                if r["skipped"]:
                    LOG.info("%d  skipped (files exist; --force to redo)", y)
                else:
                    LOG.info("%d  done  %.1f GB in %.0f s", y, r["bytes"] / 1e9, r["seconds"])
    dt = time.time() - t0
    LOG.info("summary  %.1f GB read in %.0f s  (%.0f MB/s overall)%s",
             total / 1e9, dt, total / 1e6 / max(dt, 1e-9),
             f"  — FAILED years: {failed} (re-run the same command)" if failed else "")
    return 1 if failed else 0


# ── step 2: tiles ─────────────────────────────────────────────────────────

def _period_tree(y0: int, y1: int) -> Path:
    return ROOT / "data" / ("tiles" if (y0, y1) == (1991, 2020) else f"tiles_{y0}_{y1}")


def _keys(args) -> list[str]:
    allk = list(PAIRS) + list(BP_STATS) + [AGFRAC[0]]
    if not args.keys:
        return allk
    keys = [k.strip() for k in args.keys.split(",") if k.strip()]
    bad = [k for k in keys if k not in allk]
    if bad:
        raise SystemExit(f"unknown key(s) {bad}; choose from {allk}")
    return keys


def _base_meta(key: str, levels: list[int] | None) -> dict:
    if key in PAIRS:
        units, long_name = PAIRS[key][2], PAIRS[key][3]
    elif key in BP_STATS:
        units, long_name = BP_STATS[key][3], BP_STATS[key][4]
    else:
        units, long_name = AGFRAC[1], AGFRAC[2]
    meta = {
        "var": key, "group": GROUP, "long_name": long_name, "units": units,
        "shape": [181, 360], "lat_descending": True,
        "lat_first": 90.0, "lat_last": -90.0, "lon_first": -180.0, "lon_last": 179.0,
        "levels": levels if key not in BP_STATS else None,
        "resolution_deg": 1.0, "source": WB2_URL, "transient": True,
    }
    if key in BP_STATS:
        meta["level_hpa"] = BP_STATS[key][2]
        meta["band_days"] = list(BAND_DAYS)
    return meta


def _write_meta(var_dir: Path, meta: dict) -> None:
    """meta.json, keeping per-tile entries from an earlier run (cf.
    build_tiles._carry_over_tile_meta): compress_var_dir merges into them."""
    mp_ = var_dir / "meta.json"
    if mp_.exists():
        try:
            old = json.loads(mp_.read_text())
            if old.get("tiles"):
                meta["tiles"] = old["tiles"]
        except (OSError, ValueError):
            pass
    mp_.write_text(json.dumps(meta, indent=2))


def _tile_value(src: dict, key: str, diurnal: str) -> np.ndarray:
    if key in PAIRS:
        v = src[f"cov_{key}"]
        return v - src[f"dcov_{key}"] if diurnal == "remove" else v
    return src[key]


def _zonal_cov(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """[a*b*] over longitude for (…, lat, lon) arrays."""
    return (a * b).mean(axis=-1) - a.mean(axis=-1) * b.mean(axis=-1)


def cmd_tiles(args) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from compress_tiles import compress_var_dir

    work = _abs(args.work)
    keys = _keys(args)
    have = sorted(tuple(int(x) for x in p.stem.split("-"))
                  for p in (work / "moments").glob("*.nc"))
    if not have:
        LOG.error("no moments in %s — run the moments step first", _rel(work / "moments"))
        return 1

    if args.per_year:
        root = _abs(args.root) if args.root else ROOT / "data" / "tiles_per_year"
        if args.years:
            ya, yb = (int(x) for x in args.years.split("-"))
            have = [(y, m) for y, m in have if ya <= y <= yb]
        first = min(y for y, _ in have)
        if first > 1961 and root == ROOT / "data" / "tiles_per_year" and not args.allow_late_start:
            LOG.error("per-year moments start in %d. pipeline/validate_manifest.py (run by the "
                      "monthly refresh) fails any per-year var starting after 1961, which would stop "
                      "the refresh from publishing. Build 1961–2022 moments first, or pass --root to "
                      "write a separate tree (or --allow-late-start if you really mean it).", first)
            return 2
        written = _tiles_per_year(work, root, keys, have, args.diurnal)
    else:
        y0, y1 = (int(x) for x in args.period.split("-"))
        root = _abs(args.root) if args.root else _period_tree(y0, y1)
        written = _tiles_climatology(work, root, keys, have, y0, y1, args)
        if written is None:
            return 1

    for var_dir in written:
        compress_var_dir(var_dir, args.gzip_level, force=True)
    # A staging tree (e.g. on the VM) has no manifest: writing one would list
    # only this group, and uploading it would hide every other field.
    has_manifest = (root / "manifest.json").exists()
    if has_manifest:
        update_manifest_group(root, GROUP)
    else:
        LOG.info("%s has no manifest.json (staging tree) — not writing one. Sync %s/ into the "
                 "real tree, then: build_transients.py manifest --root <tree>", _rel(root), GROUP)
    LOG.info("upload: tiles, then meta.json (revalidated)%s:",
             ", then the manifest" if has_manifest else "")
    tree = root.name
    print(f'  gsutil -o "GSUtil:parallel_process_count=1" -m -q -h '
          f'"Cache-Control:public,max-age=31536000,immutable" rsync -r -x \'.*meta\\.json$\' '
          f'{_rel(root)}/{GROUP} gs://gc-atlas-era5/{tree}/{GROUP}')
    print(f'  gsutil -o "GSUtil:parallel_process_count=1" -m -q -h '
          f'"Cache-Control:public,max-age=300,must-revalidate" rsync -r -x \'.*\\.bin\\.gz$\' '
          f'{_rel(root)}/{GROUP} gs://gc-atlas-era5/{tree}/{GROUP}')
    if has_manifest:
        print(f'  gsutil -q -h "Cache-Control:public,max-age=300,must-revalidate" cp -Z '
              f'{_rel(root)}/manifest.json gs://gc-atlas-era5/{tree}/manifest.json')
    return 0


def cmd_manifest(args) -> int:
    """Re-add the transients group to a tree's manifest.json from the
    <group>/<var>/meta.json files on disk — for a local mirror that got
    the tiles by download (the run plan builds them on a VM)."""
    root = _abs(args.root)
    if not (root / GROUP).is_dir():
        LOG.error("no %s/ under %s", GROUP, _rel(root))
        return 1
    if not (root / "manifest.json").exists():
        LOG.error("%s has no manifest.json — refusing to write one that lists only %r",
                  _rel(root), GROUP)
        return 1
    update_manifest_group(root, GROUP)
    return 0


def _tiles_per_year(work: Path, root: Path, keys: list[str], have, diurnal: str) -> list[Path]:
    out_dirs = {k: root / GROUP / k for k in keys if k != AGFRAC[0]}
    for d in out_dirs.values():
        d.mkdir(parents=True, exist_ok=True)
    levels = None
    for y, m in have:
        src, _, levels = read_nc(moments_path(work, y, m))
        bp_file = bandpass_path(work, y, m)
        if any(k in BP_STATS for k in out_dirs):
            if not bp_file.exists():
                raise SystemExit(f"missing {_rel(bp_file)} — re-run moments for {y}")
            src.update(read_nc(bp_file)[0])
        for k, d in out_dirs.items():
            a = _tile_value(src, k, diurnal).astype("<f4")
            if a.ndim == 3:
                for li, p in enumerate(levels):
                    (d / f"{p}_{y}_{m:02d}.bin").write_bytes(a[li].tobytes())
            else:
                (d / f"{y}_{m:02d}.bin").write_bytes(a.tobytes())
        LOG.info("per-year  %04d-%02d", y, m)
    for k, d in out_dirs.items():
        meta = _base_meta(k, levels)
        # year_months from the files on disk, so an incremental run that
        # adds years keeps the ones written before.
        probe = f"{levels[0]}_" if meta["levels"] else ""
        yms = sorted({(int(n[len(probe):len(probe) + 4]), int(n[len(probe) + 5:len(probe) + 7]))
                      for n in os.listdir(d) if n.startswith(probe) and n.endswith((".bin", ".bin.gz"))
                      and n[len(probe):len(probe) + 4].isdigit()})
        meta.update({"has_std": False, "years": sorted({y for y, _ in yms}),
                     "year_months": [[y, m] for y, m in yms],
                     "definition": DEFINITION.format(diurnal="removed" if diurnal == "remove" else "included")})
        _write_meta(d, meta)
    return list(out_dirs.values())


def _tiles_climatology(work, root, keys, have, y0, y1, args) -> list[Path] | None:
    years = list(range(y0, y1 + 1))
    have = set(have)
    missing = [(y, m) for y in years for m in range(1, 13) if (y, m) not in have]
    if missing and not args.allow_missing:
        LOG.error("%d month(s) of %d–%d have no moments (e.g. %d-%02d); run the moments step "
                  "or pass --allow-missing", len(missing), y0, y1, *missing[0])
        return None
    out_dirs = {k: root / GROUP / k for k in keys}
    for d in out_dirs.values():
        d.mkdir(parents=True, exist_ok=True)
    want_bp = any(k in BP_STATS for k in keys)
    zonal: dict[str, list] = {}
    levels = None
    n_years = {}
    for m in range(1, 13):
        ys = [y for y in years if (y, m) in have]
        if not ys:
            LOG.warning("month %02d: no years — skipped", m)
            continue
        n_years[m] = len(ys)
        s, s2 = {}, {}                                  # Σ value, Σ value² per key
        dsum, msum, mprod = {}, {}, {}
        for y in ys:
            src, _, levels = read_nc(moments_path(work, y, m))
            if want_bp:
                bp_file = bandpass_path(work, y, m)
                if not bp_file.exists():
                    raise SystemExit(f"missing {_rel(bp_file)} — re-run moments for {y}")
                src.update(read_nc(bp_file)[0])
            for k in keys:
                v = _tile_value(src, k, args.diurnal)
                s[k] = s.get(k, 0) + v
                s2[k] = s2.get(k, 0) + v * v
            for k, (a, b, *_) in PAIRS.items():
                dsum[k] = dsum.get(k, 0) + src[f"dcov_{k}"]
                mprod[k] = mprod.get(k, 0) + src[f"mean_{a}"] * src[f"mean_{b}"]
            for v in FIELDS:
                msum[v] = msum.get(v, 0) + src[f"mean_{v}"]
        n = len(ys)
        for k, d in out_dirs.items():
            clim = s[k] / n
            std = np.sqrt(np.maximum(s2[k] / n - clim * clim, 0.0))   # ddof=0, as build_tiles
            for tag, arr in (("", clim), ("std_", std)):
                arr = arr.astype("<f4")
                if arr.ndim == 3:
                    for li, p in enumerate(levels):
                        (d / f"{tag}{p}_{m:02d}.bin").write_bytes(arr[li].tobytes())
                else:
                    (d / f"{tag}{m:02d}.bin").write_bytes(arr.tobytes())
        # Zonal-mean summary: transient, its diurnal part, the inter-annual
        # covariance of monthly means, and the stationary eddies of the
        # period-mean fields — the full decomposition, for validation.
        mclim = {v: msum[v] / n for v in FIELDS}
        for k, (a, b, *_) in PAIRS.items():
            if f"trans_{k}" not in zonal:
                for pre in ("trans", "diurnal", "interannual", "stationary"):
                    zonal[f"{pre}_{k}"] = [None] * 12
            zonal[f"trans_{k}"][m - 1] = s[k].mean(axis=-1) / n if k in s else None
            zonal[f"diurnal_{k}"][m - 1] = dsum[k].mean(axis=-1) / n
            zonal[f"interannual_{k}"][m - 1] = (mprod[k] / n - mclim[a] * mclim[b]).mean(axis=-1)
            zonal[f"stationary_{k}"][m - 1] = _zonal_cov(mclim[a], mclim[b])
        LOG.info("climatology  month %02d  (%d years)", m, n)

    tag = "removed" if args.diurnal == "remove" else "included"
    for k, d in out_dirs.items():
        meta = _base_meta(k, levels)
        meta.update({"has_std": True, "period": f"{y0}-{y1}",
                     "n_years": n_years, "definition": DEFINITION.format(diurnal=tag)
                     + (f", averaged over {y0}-{y1} by calendar month" if k in PAIRS else "")})
        _write_meta(d, meta)
    _write_zonal_summary(work, y0, y1, zonal, levels, args.diurnal)
    return list(out_dirs.values())


def _write_zonal_summary(work: Path, y0: int, y1: int, zonal: dict, levels, diurnal: str) -> None:
    import xarray as xr
    data_vars = {}
    for name, per_month in zonal.items():
        if all(x is None for x in per_month):
            continue                       # key left out with --keys
        blank = np.full((len(levels), len(LATS)), np.nan)
        k = name.split("_", 1)[1]
        data_vars[name] = (("month", "level", "latitude"),
                           np.stack([blank if x is None else x for x in per_month]).astype(np.float32),
                           {"units": PAIRS[k][2]})
    ds = xr.Dataset(data_vars, coords={"month": np.arange(1, 13), "level": levels, "latitude": LATS},
                    attrs={"period": f"{y0}-{y1}", "tile_diurnal_cycle": diurnal,
                           "note": "zonal means: trans = tiled transient covariance; diurnal = its "
                                   "mean-diurnal-cycle part; interannual = covariance of the monthly "
                                   "means across years; stationary = [a*b*] of the period-mean fields"})
    out = work / f"zonal_{y0}_{y1}.nc"
    tmp = out.with_name(out.name + ".part")
    ds.to_netcdf(tmp)
    os.replace(tmp, out)
    LOG.info("zonal-mean decomposition → %s", _rel(out))
    _print_summary_table(ds)


def _print_summary_table(ds) -> None:
    """Zonal-mean decomposition at the textbook reference points."""
    rows = [("vptp", 850, "K m/s"), ("upvp", 250, "m2/s2"), ("vpqp", 850, "g/kg m/s")]
    print(f"\n{'term':14s}{'month':>6s}  {'lat':>5s}  {'transient':>10s} {'diurnal':>9s} "
          f"{'interann.':>10s} {'stationary':>11s}")
    for k, p, unit in rows:
        if f"trans_{k}" not in ds:
            continue
        scale = 1e3 if k == "vpqp" else 1.0
        for mo in (1, 7):
            tr = ds[f"trans_{k}"].sel(month=mo, level=p).values * scale
            if not np.isfinite(tr).any():
                continue
            nh = ds.latitude.values > 0
            i = int(np.argmax(np.abs(np.where(nh, tr, 0))))
            j = int(np.argmax(np.abs(np.where(~nh, tr, 0))))
            for idx in (i, j):
                lat = float(ds.latitude.values[idx])
                vals = [ds[f"{pre}_{k}"].sel(month=mo, level=p).values[idx] * scale
                        for pre in ("trans", "diurnal", "interannual", "stationary")]
                print(f"{k}@{p:<4d}{unit:>4s} {mo:>4d}  {lat:5.0f}  " +
                      " ".join(f"{v:10.2f}" for v in vals))


def update_manifest_group(tiles_root: Path, group: str) -> None:
    """Set manifest.json["groups"][group] from <group>/<var>/meta.json and
    leave every other group as it is (compress_tiles.refresh_root_manifest
    re-pools the whole tree, which isn't this script's business). The
    entries are slim — per-tile vmin/vmax stays in each var's meta.json,
    which js/era5.js ensureTileMeta fetches lazily; a later
    refresh_root_manifest run re-inlines them unless --slim-manifest."""
    mpath = tiles_root / "manifest.json"
    text = mpath.read_text() if mpath.exists() else ""
    manifest = json.loads(text) if text else {"groups": {}}
    vars_ = {}
    gdir = tiles_root / group
    for var_dir in sorted(p for p in gdir.iterdir() if p.is_dir()):
        mp_ = var_dir / "meta.json"
        if mp_.exists():
            meta = json.loads(mp_.read_text())
            meta.pop("tiles", None)
            vars_[var_dir.name] = meta
    manifest.setdefault("groups", {})[group] = vars_
    indent = 2 if text.startswith("{\n") else None     # keep the file's existing style
    mpath.write_text(json.dumps(manifest, indent=indent,
                                separators=None if indent else (",", ":")))
    LOG.info("manifest  %s  group %r: %d vars", _rel(mpath), group, len(vars_))


# ── check: textbook magnitudes ────────────────────────────────────────────

def _load_months(work: Path, months: list[tuple[int, int]]) -> tuple[dict, list[int]]:
    """Mean over `months` of the moments (+ band-pass when present)."""
    acc, levels = {}, None
    for y, m in months:
        src, _, levels = read_nc(moments_path(work, y, m))
        bp = bandpass_path(work, y, m)
        if bp.exists():
            src.update(read_nc(bp)[0])
        for k, v in src.items():
            acc[k] = acc.get(k, 0) + v
    return {k: v / len(months) for k, v in acc.items()}, levels


def _decode_tile(var_dir: Path, key: str) -> np.ndarray | None:
    """A GC-ATLAS f16-gz tile as float32 (the era5.js decode), or None."""
    path = var_dir / f"{key}.bin.gz"
    meta_path = var_dir / "meta.json"
    if not path.exists() or not meta_path.exists():
        return None
    t = json.loads(meta_path.read_text()).get("tiles", {}).get(key)
    if not t:
        return None
    q = np.frombuffer(gzip.decompress(path.read_bytes()), dtype="<u2")
    out = t["vmin"] + q.astype(np.float64) * (t["vmax"] - t["vmin"]) / 65534
    out[q == 0xFFFF] = np.nan
    return out.reshape(181, 360)


def cmd_check(args) -> int:
    work = _abs(args.work)
    months = []
    for spec in args.months.split(","):
        a, _, b = spec.partition("..")
        months += month_range(a, b or a)
    f, levels = _load_months(work, months)
    li = {p: k for k, p in enumerate(levels)}
    lat = LATS
    nh, sh = lat > 0, lat < 0
    label = ", ".join(f"{y}-{m:02d}" for y, m in months) if len(months) <= 3 else \
        f"{months[0][0]}-{months[0][1]:02d} … {months[-1][0]}-{months[-1][1]:02d} ({len(months)} months)"
    print(f"\nTransient-eddy check — {label}\n")

    def zm(name, p):
        return f[name][li[p]].mean(axis=-1)

    def ext(z, mask, sign=+1):
        zz = np.where(mask, sign * z, -np.inf)
        i = int(np.argmax(zz))
        return z[i], lat[i]

    def stat(a, b, p):
        return _zonal_cov(f[f"mean_{a}"][li[p]], f[f"mean_{b}"][li[p]])

    print("Zonal means (transient = sub-monthly; stationary = this slice's monthly-mean eddies)")
    for key, p, sign_n, unit, scale, ref in (
            ("vptp", 850, +1, "K m s-1", 1, "DJF ≈ 15–20 near 45–50°N"),
            ("vptp", 200, +1, "K m s-1", 1, ""),
            ("upvp", 250, +1, "m2 s-2", 1, "DJF ≈ 40–50 poleward near 35–40°N"),
            ("upvp", 200, +1, "m2 s-2", 1, ""),
            ("vpqp", 850, +1, "g kg-1 m s-1", 1e3, ""),
            ("tptp", 850, +1, "K2", 1, ""),
            ("wptp", 500, -1, "K Pa s-1", 1, "ω'T' < 0: warm air rises (C(P_E→K_E) > 0)")):
        a, b = PAIRS[key][:2]
        z = zm(f"cov_{key}", p) * scale
        s = stat(a, b, p) * scale
        vn, la_n = ext(z, nh, sign_n)
        vs, la_s = ext(z, sh, sign_n if key in ("tptp", "wptp", "upup", "vpvp") else -sign_n)
        d = zm(f"dcov_{key}", p) * scale
        i_n = int(np.argmin(np.abs(lat - la_n)))
        print(f"  [{key}] {p:4d} hPa  NH {vn:8.2f} at {la_n:+5.0f}°  SH {vs:8.2f} at {la_s:+5.0f}°  "
              f"{unit:13s} (stationary at NH peak {s[i_n]:7.2f}, diurnal {d[i_n]:6.2f})"
              + (f"   ref: {ref}" if ref else ""))

    for p in (250, 300, 850):
        eke = 0.5 * (f["cov_upup"][li[p]] + f["cov_vpvp"][li[p]])
        z = eke.mean(axis=-1)
        vn, la_n = ext(z, nh)
        vs, la_s = ext(z, sh)
        print(f"  [EKE]  {p:4d} hPa  NH {vn:8.1f} at {la_n:+5.0f}°  SH {vs:8.1f} at {la_s:+5.0f}°  m2 s-2")

    print("\nRegional maxima (storm tracks)")
    lon2d, lat2d = np.meshgrid(LONS, LATS)
    boxes = {"N Pacific": (lat2d > 25) & (lat2d < 65) & ((lon2d > 130) | (lon2d < -120)),
             "N Atlantic": (lat2d > 25) & (lat2d < 70) & (lon2d > -80) & (lon2d < 10),
             "N America": (lat2d > 25) & (lat2d < 65) & (lon2d > -120) & (lon2d < -80),
             "S Ocean": (lat2d < -30) & (lat2d > -70)}
    maps = {"EKE 250 hPa (m2 s-2)": 0.5 * (f["cov_upup"][li[250]] + f["cov_vpvp"][li[250]]),
            "v'T' 850 hPa (K m s-1)": f["cov_vptp"][li[850]] * np.sign(lat2d + 1e-9),
            "Φ' rms 500 hPa (m)": np.sqrt(np.maximum(f["cov_zpzp"][li[500]], 0)) / 9.80665}
    if "z500bp" in f:
        maps["2–8-d Φ' rms 500 hPa (m)"] = np.sqrt(np.maximum(f["z500bp"], 0)) / 9.80665
        maps["2–8-d v'T' 850 hPa (K m s-1)"] = f["vt850bp"] * np.sign(lat2d + 1e-9)
    for name, mp_ in maps.items():
        parts = []
        for bname, box in boxes.items():
            v = np.where(box, mp_, -np.inf)
            i = np.unravel_index(int(np.argmax(v)), v.shape)
            parts.append(f"{bname} {mp_[i]:6.1f} ({LATS[i[0]]:+.0f}°, {LONS[i[1]]:+.0f}°)")
        print(f"  {name:28s} " + "   ".join(parts))
    print("  (v'T' columns are poleward-positive in both hemispheres)")

    print("\nMean diurnal-cycle share of the transient term, area-weighted |dcov| / |cov|")
    w = np.cos(np.deg2rad(lat))[:, None]
    for p in (1000, 850, 500, 250):
        parts = []
        for k in PAIRS:
            c, d = f[f"cov_{k}"][li[p]], f[f"dcov_{k}"][li[p]]
            parts.append(f"{k} {np.sum(w * np.abs(d)) / np.sum(w * np.abs(c)):5.1%}")
        print(f"  {p:4d} hPa  " + "  ".join(parts))

    ag = f["agfrac"]
    print(f"\nagfrac: min {ag.min():.2f}; fraction of 1000 hPa cells < 0.5: "
          f"{np.mean(ag[li[1000]] < 0.5):.1%}; at 500 hPa: {np.mean(ag[li[500]] < 0.5):.2%}")

    # Orientation / units cross-check against GC-ATLAS's own per-year tiles
    # (CDS monthly means, a different product: expect close, not identical).
    py = ROOT / "data" / "tiles_per_year" / "pressure_levels"
    rows = []
    for v, p in (("u", 250), ("t", 850), ("v", 850), ("z", 500)):
        tiles = [_decode_tile(py / v, f"{p}_{y}_{m:02d}") for y, m in months]
        if any(t is None for t in tiles):
            continue
        ref = np.mean(tiles, axis=0)
        ours = f[f"mean_{v}"][li[p]]
        ok = np.isfinite(ref)
        r = np.corrcoef(ours[ok], ref[ok])[0, 1]
        rows.append(f"{v}{p} r={r:.4f} rms diff {np.sqrt(np.mean((ours[ok] - ref[ok]) ** 2)):.3g} "
                    f"{FIELD_UNITS[v]}")
    if rows:
        print("\nWB2 monthly means vs GC-ATLAS per-year tiles: " + "; ".join(rows))
    print()
    return 0


# ── bench ─────────────────────────────────────────────────────────────────

def _bench_one(url: str, threads: int, i0: int, steps: int) -> tuple[int, float]:
    rd = WB2(url, threads)
    t0 = time.time()
    for f in rd.submit(READ_ALL, i0, i0 + steps).values():
        f.result()
    return rd.store.nbytes, time.time() - t0


def cmd_bench(args) -> int:
    steps = args.days * STEPS_PER_DAY
    base = tindex(month_start(2000, 1))
    t0 = time.time()
    if args.workers <= 1:
        nbytes, _ = _bench_one(args.url, args.threads, base, steps)
    else:
        ctx = mp.get_context("spawn")
        with ProcessPoolExecutor(args.workers, mp_context=ctx) as ex:
            futs = [ex.submit(_bench_one, args.url, args.threads, base + 40 * w * STEPS_PER_DAY, steps)
                    for w in range(args.workers)]
            nbytes = sum(f.result()[0] for f in futs)
    dt = time.time() - t0
    rate = nbytes / dt
    LOG.info("bench  %d worker(s) × %d days × %d arrays: %.2f GB in %.1f s → %.0f MB/s  "
             "(at this rate: 1991–2020 ≈ %.1f h, 1961–2022 ≈ %.1f h of reads)",
             max(args.workers, 1), args.days, len(READ_ALL), nbytes / 1e9, dt,
             rate / 1e6, 0.72e12 / rate / 3600, 1.50e12 / rate / 3600)
    return 0


# ── CLI ───────────────────────────────────────────────────────────────────

def _abs(p: str | Path) -> Path:
    p = Path(p)
    return p if p.is_absolute() else ROOT / p


def _rel(path: Path) -> Path:
    return path.relative_to(ROOT) if path.is_relative_to(ROOT) else path


def parse_args(argv=None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--work", default=str(WORK_DIR),
                        help="moments / band-pass / summary directory (default data/transients)")
    common.add_argument("--url", default=WB2_URL, help="WB2 zarr store")
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("moments", parents=[common],
                       help="stream WB2 → per-(year, month) moment files")
    m.add_argument("--start", required=True, help="first month, YYYY-MM")
    m.add_argument("--end", required=True, help="last month, YYYY-MM (≤ 2022-12)")
    m.add_argument("--workers", type=int, default=1, help="years processed in parallel (processes)")
    m.add_argument("--threads", type=int, default=16, help="read threads per worker")
    m.add_argument("--days-per-read", type=int, default=4,
                   help="days per read (each field = one chunk per day)")
    m.add_argument("--no-bandpass", action="store_true",
                   help="skip the 2–8-day storm-track statistics (and their ±15-day halo reads)")
    m.add_argument("--force", action="store_true", help="recompute months whose files exist")

    t = sub.add_parser("tiles", parents=[common],
                       help="moments → GC-ATLAS tiles (f16-gz) + manifest group")
    g = t.add_mutually_exclusive_group(required=True)
    g.add_argument("--period", help="climatology window START-END, e.g. 1991-2020 "
                                    "(→ data/tiles; other windows → data/tiles_START_END)")
    g.add_argument("--per-year", action="store_true",
                   help="per-(year, month) tiles (→ data/tiles_per_year)")
    t.add_argument("--years", help="per-year: restrict to START-END")
    t.add_argument("--root", help="write into this tree instead (testing)")
    t.add_argument("--keys", help="comma-separated subset of tile keys (default: all)")
    t.add_argument("--diurnal", choices=["include", "remove"], default="include",
                   help="keep the mean diurnal cycle in the covariances (default) or subtract it")
    t.add_argument("--allow-missing", action="store_true",
                   help="climatology from the years present when some months lack moments")
    t.add_argument("--allow-late-start", action="store_true",
                   help="per-year into data/tiles_per_year even if the span starts after 1961")
    t.add_argument("--gzip-level", type=int, default=9)

    c = sub.add_parser("check", parents=[common],
                       help="print zonal-mean / storm-track magnitudes for some months")
    c.add_argument("--months", required=True,
                   help="YYYY-MM, a list (1999-12,2000-01,2000-02) or a range (1991-01..1991-03)")

    b = sub.add_parser("bench", parents=[common], help="measure read throughput from this machine")
    b.add_argument("--days", type=int, default=4)
    b.add_argument("--workers", type=int, default=1)
    b.add_argument("--threads", type=int, default=16)

    mf = sub.add_parser("manifest", parents=[common],
                        help="add the transients group to an existing tree's manifest.json")
    mf.add_argument("--root", required=True, help="tile tree, e.g. data/tiles or data/tiles_per_year")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args(argv)
    return {"moments": cmd_moments, "tiles": cmd_tiles, "check": cmd_check,
            "bench": cmd_bench, "manifest": cmd_manifest}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
