"""Build cross-year σ (inter-annual standard deviation) tiles for derived
fields that are currently computed on the fly by the browser: wind speed
(|V|), moist static energy (h/c_p), and deep-layer shear (|V_200 − V_850|).

The client can't build an honest σ-tile for a derived field from σ-of-
components alone — σ(√(u²+v²)) ≠ √(σ(u)² + σ(v)²) unless u and v are
independent. The right route is to compute the derived field year-by-year,
then take the cross-year std. That's what this script does, from the raw
ERA5 monthly-mean NetCDFs.

Output layout (mirrors build_tiles.py — per-variable directories under the
chosen period tree, only std tiles written):

    data/tiles[_PERIOD]/
        pressure_levels/
            wspd/
                meta.json
                std_10_01.bin  …  std_1000_12.bin
            mse/
                meta.json
                std_10_01.bin  …  std_1000_12.bin
        single_levels/
            dls/
                meta.json
                std_01.bin  …  std_12.bin

The meta.json declares has_std: true and has_mean: false — the frontend
keeps computing the mean on the fly (fast, exact) and fetches σ from disk.

A follow-up `python pipeline/compress_tiles.py --root data/tiles[_PERIOD]`
pass will fold these new files into the f16-gz encoding + refresh the
root manifest to include wspd / mse / dls.

Usage:
    python pipeline/build_derived_std.py                              # default period (data/raw → data/tiles)
    python pipeline/build_derived_std.py --period 1961-1990           # alt window
    python pipeline/build_derived_std.py --var wspd                   # one var at a time
    python pipeline/build_derived_std.py --force                      # rebuild even if std tiles present
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

LOG = logging.getLogger("gc-atlas.build_derived_std")
ROOT = Path(__file__).resolve().parent.parent

# Native grid of the CDS download.
SRC_RES = 0.5

# MSE constants — match js/data.js so the derived grid from this pipeline
# matches the on-the-fly client compute to numerical precision.
CP_DRY = 1004.0          # J kg⁻¹ K⁻¹
G_ACC  = 9.80665
L_V    = 2.501e6         # J kg⁻¹

DLS_TOP = 200
DLS_BOT = 850

DERIVED = ("wspd", "mse", "dls")


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--period", help="START-END window (e.g. 1961-1990). Default reads data/raw/ → data/tiles/.")
    ap.add_argument("--var", choices=DERIVED, help="build only this derived var (default: all three)")
    ap.add_argument("--resolution", type=float, default=1.0,
                    help="target grid spacing in degrees (default 1.0; source is 0.5)")
    ap.add_argument("--force", action="store_true", help="rebuild even if std tiles already exist")
    return ap.parse_args()


def _rename_time(ds: xr.Dataset) -> xr.Dataset:
    if "valid_time" in ds.coords and "time" not in ds.coords:
        ds = ds.rename({"valid_time": "time"})
    return ds


def _lat_lon_names(da: xr.DataArray) -> tuple[str, str]:
    lat = "latitude"  if "latitude"  in da.dims else "lat"
    lon = "longitude" if "longitude" in da.dims else "lon"
    return lat, lon


def _lev_name(da: xr.DataArray) -> str | None:
    if "pressure_level" in da.dims:
        return "pressure_level"
    if "level" in da.dims:
        return "level"
    return None


def _downsample(da: xr.DataArray, res: float) -> xr.DataArray:
    lat, lon = _lat_lon_names(da)
    step = max(1, int(round(res / SRC_RES)))
    if step == 1:
        return da
    return da.isel({lat: slice(None, None, step), lon: slice(None, None, step)})


def _open_component(raw_dir: Path, group: str, short: str) -> xr.DataArray:
    nc = raw_dir / f"era5_{group}_{short}.nc"
    if not nc.exists():
        raise FileNotFoundError(f"missing {nc}")
    ds = _rename_time(xr.open_dataset(nc))
    # Pick the data variable — name sometimes differs from the short code
    # (e.g. 'q' → 'q', but CDS occasionally ships with the long name).
    if short in ds.data_vars:
        return ds[short]
    if len(ds.data_vars) == 1:
        return ds[next(iter(ds.data_vars))]
    raise RuntimeError(f"can't pick var in {nc.name} (candidates: {list(ds.data_vars)})")


def _write_std_tiles(std: xr.DataArray, out_dir: Path, has_level: bool,
                     levels: list[int] | None) -> int:
    """Emit std_<level>_<month>.bin (pl) or std_<month>.bin (sl). Returns
    the number of files written."""
    n = 0
    out_dir.mkdir(parents=True, exist_ok=True)
    if has_level and levels:
        for lev in levels:
            for month in range(1, 13):
                arr = std.sel(pressure_level=lev, month=month).values.astype("<f4")
                (out_dir / f"std_{lev}_{month:02d}.bin").write_bytes(arr.tobytes())
                n += 1
    else:
        for month in range(1, 13):
            arr = std.sel(month=month).values.astype("<f4")
            (out_dir / f"std_{month:02d}.bin").write_bytes(arr.tobytes())
            n += 1
    return n


def _write_meta(var_dir: Path, *, var: str, group: str, long_name: str,
                units: str, shape: tuple[int, int], lat_desc: bool,
                lat_first: float, lat_last: float, lon_first: float,
                lon_last: float, std_vmin: float, std_vmax: float,
                levels: list[int] | None, res: float, source_nc: str,
                year_range: tuple[int, int]) -> None:
    meta = {
        "var": var,
        "group": group,
        "long_name": long_name,
        "units": units,
        "shape": list(shape),
        "lat_descending": lat_desc,
        "lat_first": float(lat_first),
        "lat_last":  float(lat_last),
        "lon_first": float(lon_first),
        "lon_last":  float(lon_last),
        # vmin/vmax for the field itself live in the client's FIELDS table
        # (we don't write a mean tile here); copy std_vmin/std_vmax so the
        # frontend can flag the σ tile's range if it wants to.
        "vmin": None,
        "vmax": None,
        "std_vmin": float(std_vmin),
        "std_vmax": float(std_vmax),
        "has_std":  True,
        "has_mean": False,
        "derived":  True,
        "levels":   levels,
        "resolution_deg": res,
        "source_nc": source_nc,
        "period_years": list(year_range),
    }
    (var_dir / "meta.json").write_text(json.dumps(meta, indent=2))


def _period_year_range(da: xr.DataArray) -> tuple[int, int]:
    yrs = sorted(set(int(y) for y in da["time"].dt.year.values))
    return yrs[0], yrs[-1]


def _skip_if_present(var_dir: Path, has_level: bool, levels: list[int] | None,
                     force: bool) -> bool:
    """Return True if the std tile set is already complete and --force wasn't
    passed, in which case the caller skips this var."""
    if force or not var_dir.exists():
        return False
    expected = 0
    if has_level and levels:
        expected = len(levels) * 12
    else:
        expected = 12
    got = sum(1 for p in var_dir.iterdir()
              if (p.name.startswith("std_") and (p.name.endswith(".bin") or p.name.endswith(".bin.gz"))))
    return got >= expected


# ── derived field builders ───────────────────────────────────────────────

def build_wspd(raw_dir: Path, out_dir_parent: Path, res: float, force: bool) -> None:
    var_dir = out_dir_parent / "pressure_levels" / "wspd"
    LOG.info("wspd  loading u, v …")
    u = _open_component(raw_dir, "pressure_levels", "u")
    v = _open_component(raw_dir, "pressure_levels", "v")

    # Align + downsample first to keep memory manageable.
    u = _downsample(u, res)
    v = _downsample(v, res)

    lev_name = _lev_name(u)
    levels = sorted([int(p) for p in u[lev_name].values]) if lev_name else None

    if _skip_if_present(var_dir, lev_name is not None, levels, force):
        LOG.info("wspd  skip (std tiles exist — use --force to rebuild)")
        return

    speed = xr.DataArray(
        np.hypot(u.values, v.values),
        coords=u.coords, dims=u.dims,
        attrs={"units": "m s**-1", "long_name": "Wind speed |V|"},
    )

    LOG.info("wspd  groupby month + std (%d times)", u.sizes.get("time", -1))
    grouped = speed.groupby("time.month")
    std = grouped.std("time", ddof=0)

    lat_name, lon_name = _lat_lon_names(speed)
    nlat, nlon = speed.sizes[lat_name], speed.sizes[lon_name]
    lat_vals = speed[lat_name].values
    lon_vals = speed[lon_name].values

    n = _write_std_tiles(std, var_dir, lev_name is not None, levels)
    _write_meta(var_dir,
                var="wspd", group="pressure_levels",
                long_name="Wind speed (|V|)", units="m s**-1",
                shape=(nlat, nlon),
                lat_desc=bool(lat_vals[0] > lat_vals[-1]),
                lat_first=lat_vals[0], lat_last=lat_vals[-1],
                lon_first=lon_vals[0], lon_last=lon_vals[-1],
                std_vmin=float(std.min()), std_vmax=float(std.max()),
                levels=levels, res=res,
                source_nc=f"derived from era5_pressure_levels_{{u,v}}.nc",
                year_range=_period_year_range(speed))
    LOG.info("wspd  wrote %d tiles → %s", n, var_dir.relative_to(ROOT))


def build_mse(raw_dir: Path, out_dir_parent: Path, res: float, force: bool) -> None:
    var_dir = out_dir_parent / "pressure_levels" / "mse"
    LOG.info("mse   loading t, z, q …")
    T = _open_component(raw_dir, "pressure_levels", "t")
    Z = _open_component(raw_dir, "pressure_levels", "z")
    Q = _open_component(raw_dir, "pressure_levels", "q")

    T = _downsample(T, res); Z = _downsample(Z, res); Q = _downsample(Q, res)

    lev_name = _lev_name(T)
    levels = sorted([int(p) for p in T[lev_name].values]) if lev_name else None

    if _skip_if_present(var_dir, lev_name is not None, levels, force):
        LOG.info("mse   skip (std tiles exist — use --force to rebuild)")
        return

    # Raw ERA5 units: T in K, Z as geopotential (m² s⁻²), Q in kg/kg.
    # h = c_p·T + Z_raw + L_v·Q  → divide by c_p for display in K.
    h_over_cp = (CP_DRY * T.values + Z.values + L_V * Q.values) / CP_DRY

    mse_da = xr.DataArray(
        h_over_cp, coords=T.coords, dims=T.dims,
        attrs={"units": "K", "long_name": "Moist static energy h/c_p"},
    )

    LOG.info("mse   groupby month + std (%d times)", T.sizes.get("time", -1))
    grouped = mse_da.groupby("time.month")
    std = grouped.std("time", ddof=0)

    lat_name, lon_name = _lat_lon_names(mse_da)
    nlat, nlon = mse_da.sizes[lat_name], mse_da.sizes[lon_name]
    lat_vals = mse_da[lat_name].values
    lon_vals = mse_da[lon_name].values

    n = _write_std_tiles(std, var_dir, lev_name is not None, levels)
    _write_meta(var_dir,
                var="mse", group="pressure_levels",
                long_name="Moist static energy (h/c_p)", units="K",
                shape=(nlat, nlon),
                lat_desc=bool(lat_vals[0] > lat_vals[-1]),
                lat_first=lat_vals[0], lat_last=lat_vals[-1],
                lon_first=lon_vals[0], lon_last=lon_vals[-1],
                std_vmin=float(std.min()), std_vmax=float(std.max()),
                levels=levels, res=res,
                source_nc=f"derived from era5_pressure_levels_{{t,z,q}}.nc",
                year_range=_period_year_range(mse_da))
    LOG.info("mse   wrote %d tiles → %s", n, var_dir.relative_to(ROOT))


def build_dls(raw_dir: Path, out_dir_parent: Path, res: float, force: bool) -> None:
    var_dir = out_dir_parent / "single_levels" / "dls"
    LOG.info("dls   loading u, v at %d / %d hPa …", DLS_TOP, DLS_BOT)
    u = _open_component(raw_dir, "pressure_levels", "u")
    v = _open_component(raw_dir, "pressure_levels", "v")
    u = _downsample(u, res); v = _downsample(v, res)

    lev_name = _lev_name(u)
    if lev_name is None:
        raise RuntimeError("dls needs a pressure_level axis on u / v")

    uTop = u.sel({lev_name: DLS_TOP}); vTop = v.sel({lev_name: DLS_TOP})
    uBot = u.sel({lev_name: DLS_BOT}); vBot = v.sel({lev_name: DLS_BOT})

    if _skip_if_present(var_dir, has_level=False, levels=None, force=force):
        LOG.info("dls   skip (std tiles exist — use --force to rebuild)")
        return

    shear = xr.DataArray(
        np.hypot(uTop.values - uBot.values, vTop.values - vBot.values),
        coords=uTop.coords, dims=uTop.dims,
        attrs={"units": "m s**-1", "long_name": "Deep-layer shear |V_200 − V_850|"},
    )

    LOG.info("dls   groupby month + std (%d times)", shear.sizes.get("time", -1))
    grouped = shear.groupby("time.month")
    std = grouped.std("time", ddof=0)

    lat_name, lon_name = _lat_lon_names(shear)
    nlat, nlon = shear.sizes[lat_name], shear.sizes[lon_name]
    lat_vals = shear[lat_name].values
    lon_vals = shear[lon_name].values

    n = _write_std_tiles(std, var_dir, has_level=False, levels=None)
    _write_meta(var_dir,
                var="dls", group="single_levels",
                long_name="Deep-layer shear (mean-flow)", units="m s**-1",
                shape=(nlat, nlon),
                lat_desc=bool(lat_vals[0] > lat_vals[-1]),
                lat_first=lat_vals[0], lat_last=lat_vals[-1],
                lon_first=lon_vals[0], lon_last=lon_vals[-1],
                std_vmin=float(std.min()), std_vmax=float(std.max()),
                levels=None, res=res,
                source_nc=f"derived from era5_pressure_levels_{{u,v}}.nc (200, 850 hPa)",
                year_range=_period_year_range(shear))
    LOG.info("dls   wrote %d tiles → %s", n, var_dir.relative_to(ROOT))


# ── driver ────────────────────────────────────────────────────────────────

def _resolve_period_dirs(period: str | None) -> tuple[Path, Path]:
    if period is None:
        return ROOT / "data" / "raw", ROOT / "data" / "tiles"
    start, end = (int(x) for x in period.split("-"))
    return (ROOT / "data" / f"raw_{start}_{end}",
            ROOT / "data" / f"tiles_{start}_{end}")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()
    raw_dir, out_dir_parent = _resolve_period_dirs(args.period)

    if not raw_dir.exists():
        LOG.error("raw dir not found: %s", raw_dir)
        return 1
    out_dir_parent.mkdir(parents=True, exist_ok=True)
    LOG.info("raw    %s", raw_dir.relative_to(ROOT))
    LOG.info("out    %s", out_dir_parent.relative_to(ROOT))

    targets = (args.var,) if args.var else DERIVED
    builders = {"wspd": build_wspd, "mse": build_mse, "dls": build_dls}
    t0 = time.time()
    for v in targets:
        try:
            builders[v](raw_dir, out_dir_parent, args.resolution, args.force)
        except Exception as exc:
            LOG.error("FAIL  %s: %s", v, exc)
    LOG.info("all done in %.1fs", time.time() - t0)
    LOG.info("next: python pipeline/compress_tiles.py --root %s", out_dir_parent.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
