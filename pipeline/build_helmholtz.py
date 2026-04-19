"""Compute velocity potential χ and streamfunction ψ from ERA5 u, v.

ERA5 monthly_averaged_reanalysis does NOT serve χ and ψ directly (they exist
only in 6-hourly ERA5), so we derive them via Helmholtz decomposition on the
sphere. The decomposition splits the horizontal wind into:

    v_h = -∇χ + k̂ × ∇ψ

where ∇²χ = D (divergence) and ∇²ψ = ζ (vorticity). We solve the two Poisson
equations using spherical harmonic transforms (windspharm wraps pyspharm).

Output: per-(level, month) tiles in data/tiles/pressure_levels/{chi,psi}/,
matching the build_tiles.py format. Also writes meta.json with units and the
optional std-across-years tiles.

Pedagogy:
  • 200 hPa χ shows large-scale rising/sinking centres (negative χ over the
    Maritime Continent rising branch, positive over east-Pacific sinking) —
    the cleanest Walker / ENSO diagnostic.
  • 200 hPa ψ shows the upper-trop circulation skeleton (jet axes, subtropical
    anticyclones, planetary Rossby-wave structure when paired with Eddy mode).

Install (one-time):
    pip install windspharm
    # On macOS, pyspharm needs gfortran. If pip install fails:
    #   brew install gfortran
    #   pip install windspharm

Usage:
    python pipeline/build_helmholtz.py             # compute both, all levels, with std
    python pipeline/build_helmholtz.py --no-std    # skip std (faster)
    python pipeline/build_helmholtz.py --force     # overwrite existing tiles
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

LOG = logging.getLogger("gc-atlas.helmholtz")
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "data" / "tiles" / "pressure_levels"
SRC_RES = 0.5    # ERA5 native (CDS download) grid


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--resolution", type=float, default=1.0,
                    help="target grid spacing in degrees (default 1.0; source is 0.5)")
    ap.add_argument("--no-std", action="store_true", help="skip std-across-years tiles")
    ap.add_argument("--force", action="store_true", help="overwrite existing tiles")
    return ap.parse_args()


def _rename_time(ds: xr.Dataset) -> xr.Dataset:
    if "valid_time" in ds.coords and "time" not in ds.coords:
        ds = ds.rename({"valid_time": "time"})
    return ds


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()

    try:
        from windspharm.xarray import VectorWind
    except ImportError:
        LOG.error(
            "windspharm not installed. Install with:  pip install windspharm  "
            "(brings pyspharm; on macOS you may need:  brew install gfortran  first)"
        )
        return 1

    u_path = RAW_DIR / "era5_pressure_levels_u.nc"
    v_path = RAW_DIR / "era5_pressure_levels_v.nc"
    if not u_path.exists() or not v_path.exists():
        LOG.error("Need both %s and %s", u_path, v_path)
        return 1

    LOG.info("open  %s + %s", u_path.name, v_path.name)
    ds_u = _rename_time(xr.open_dataset(u_path))
    ds_v = _rename_time(xr.open_dataset(v_path))

    u = ds_u["u"]
    v = ds_v["v"]

    lat_name = "latitude" if "latitude" in u.dims else "lat"
    lon_name = "longitude" if "longitude" in u.dims else "lon"

    # Downsample spatially before computing — SHT cost scales with resolution².
    step = max(1, int(round(args.resolution / SRC_RES)))
    if step > 1:
        u = u.isel({lat_name: slice(None, None, step), lon_name: slice(None, None, step)})
        v = v.isel({lat_name: slice(None, None, step), lon_name: slice(None, None, step)})

    LOG.info("compute Helmholtz (this is the slow step — SHT per timestep)")
    t0 = time.time()
    w = VectorWind(u, v)
    chi = w.velocitypotential()      # m² s⁻¹
    psi = w.streamfunction()         # m² s⁻¹
    LOG.info("done   helmholtz in %.0fs", time.time() - t0)

    LOG.info("clim   month-of-year mean / std")
    grouped_chi = chi.groupby("time.month")
    grouped_psi = psi.groupby("time.month")
    chi_mean = grouped_chi.mean("time")
    psi_mean = grouped_psi.mean("time")
    if args.no_std:
        chi_std = psi_std = None
    else:
        chi_std = grouped_chi.std("time")
        psi_std = grouped_psi.std("time")

    lev_name = "pressure_level" if "pressure_level" in chi_mean.dims else "level"
    lat_name = "latitude" if "latitude" in chi_mean.dims else "lat"
    lon_name = "longitude" if "longitude" in chi_mean.dims else "lon"

    levels = sorted([int(p) for p in chi_mean[lev_name].values])
    nlat = chi_mean.sizes[lat_name]
    nlon = chi_mean.sizes[lon_name]
    lat_vals = chi_mean[lat_name].values
    lon_vals = chi_mean[lon_name].values
    lat_desc = bool(lat_vals[0] > lat_vals[-1])

    for short, mean_da, std_da, long_name, units in [
        ("chi", chi_mean, chi_std, "Velocity potential", "m**2 s**-1"),
        ("psi", psi_mean, psi_std, "Streamfunction",      "m**2 s**-1"),
    ]:
        out_dir = OUT_DIR / short
        if out_dir.exists() and not args.force:
            LOG.info("skip   %s (exists — pass --force to rebuild)", short)
            continue
        out_dir.mkdir(parents=True, exist_ok=True)

        for lev in levels:
            for month in range(1, 13):
                arr = mean_da.sel({lev_name: lev, "month": month}).values.astype("<f4")
                (out_dir / f"{lev}_{month:02d}.bin").write_bytes(arr.tobytes())
                if std_da is not None:
                    arrS = std_da.sel({lev_name: lev, "month": month}).values.astype("<f4")
                    (out_dir / f"std_{lev}_{month:02d}.bin").write_bytes(arrS.tobytes())

        meta = {
            "var": short,
            "group": "pressure_levels",
            "long_name": long_name,
            "units": units,
            "shape": [nlat, nlon],
            "lat_descending": lat_desc,
            "lat_first": float(lat_vals[0]),
            "lat_last":  float(lat_vals[-1]),
            "lon_first": float(lon_vals[0]),
            "lon_last":  float(lon_vals[-1]),
            "vmin": float(mean_da.min()),
            "vmax": float(mean_da.max()),
            "has_std": std_da is not None,
            "std_vmin": float(std_da.min()) if std_da is not None else None,
            "std_vmax": float(std_da.max()) if std_da is not None else None,
            "levels": levels,
            "resolution_deg": args.resolution,
            "source_nc": "derived from era5_pressure_levels_{u,v}.nc",
        }
        (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))
        LOG.info("done   %s   range=[%.3g, %.3g]", short, meta["vmin"], meta["vmax"])

    LOG.info("regen  manifest.json")
    refresh_manifest()
    return 0


def refresh_manifest():
    """Walk data/tiles/ and regenerate manifest.json — same logic build_tiles.py uses."""
    tiles_root = ROOT / "data" / "tiles"
    groups: dict = {}
    for group_dir in sorted(tiles_root.iterdir()):
        if not group_dir.is_dir():
            continue
        vars_: dict = {}
        for var_dir in sorted(group_dir.iterdir()):
            mp = var_dir / "meta.json"
            if mp.exists():
                vars_[var_dir.name] = json.loads(mp.read_text())
        if vars_:
            groups[group_dir.name] = vars_
    (tiles_root / "manifest.json").write_text(json.dumps({"groups": groups}, indent=2))


if __name__ == "__main__":
    sys.exit(main())
