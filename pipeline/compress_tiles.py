"""Compress an existing tile tree to float16 + gzip, in-place.

Walks every variable directory under a tile root and replaces each .bin
(little-endian float32, [lat × lon] row-major) with a .bin.gz file:

    1. Read the float32 array.
    2. Find per-tile vmin / vmax from finite samples.
    3. Quantize to uint16 in [0, 65534] mapping to [vmin, vmax]. Reserve
       0xFFFF as the NaN sentinel.
    4. Gzip the uint16 buffer.
    5. Write {tile}.bin.gz, remove the original {tile}.bin.

Per-tile vmin/vmax goes into meta.json under `tiles` so the frontend can
dequantize. The variable-level meta.json gains `encoding: "f16-gz"` so
era5.js can pick the right decode path. Variables that are already
compressed (encoding present) are skipped unless --force.

Quantization error: ≈ (vmax-vmin)/65534 ≈ 1.5e-5 of the field's range.
For T (200 K range) → 0.003 K. For u (200 m/s range) → 0.003 m/s. Below
visualization noise floors and below the spectral-truncation noise that's
already in ERA5 at 1° regridding.

Usage:
    python pipeline/compress_tiles.py                                    # data/tiles_per_year/
    python pipeline/compress_tiles.py --root data/tiles                  # the climatology tree
    python pipeline/compress_tiles.py --var sst --group single_levels    # one var smoke test
    python pipeline/compress_tiles.py --force                            # re-compress already-compressed
"""
from __future__ import annotations

import argparse
import gzip
import json
import logging
import sys
import time
from pathlib import Path

import numpy as np

LOG = logging.getLogger("gc-atlas.compress_tiles")
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TILES_ROOT = ROOT / "data" / "tiles_per_year"


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=str(DEFAULT_TILES_ROOT),
                    help="tile-tree root (e.g. data/tiles_per_year, data/tiles, data/tiles_1961_1990)")
    ap.add_argument("--var", help="short name filter (e.g. sst)")
    ap.add_argument("--group", choices=["pressure_levels", "single_levels"],
                    help="restrict to one group")
    ap.add_argument("--force", action="store_true",
                    help="re-compress even if encoding is already 'f16-gz'")
    ap.add_argument("--gzip-level", type=int, default=9,
                    help="gzip compression level 1-9 (default 9, max compression)")
    return ap.parse_args()


def compress_var_dir(var_dir: Path, gzip_level: int, force: bool) -> tuple[int, int, int]:
    """Compress every .bin in `var_dir` to .bin.gz. Returns
    (n_tiles_compressed, total_input_bytes, total_output_bytes).
    Updates meta.json in place with encoding + per-tile vmin/vmax.
    """
    meta_path = var_dir / "meta.json"
    if not meta_path.exists():
        LOG.warning("skip  %s (no meta.json)", var_dir.relative_to(ROOT))
        return 0, 0, 0
    meta = json.loads(meta_path.read_text())
    if meta.get("encoding") == "f16-gz" and not force:
        LOG.info("skip  %s (already f16-gz; use --force to redo)", var_dir.relative_to(ROOT))
        return 0, 0, 0

    bin_files = sorted(p for p in var_dir.iterdir() if p.name.endswith(".bin"))
    if not bin_files:
        LOG.info("skip  %s (no .bin files)", var_dir.relative_to(ROOT))
        return 0, 0, 0

    in_bytes = 0
    out_bytes = 0
    tiles: dict[str, dict] = {}
    t0 = time.time()
    for bin_path in bin_files:
        arr = np.fromfile(bin_path, dtype="<f4")
        in_bytes += arr.nbytes
        finite = np.isfinite(arr)
        if not finite.any():
            vmin, vmax = 0.0, 1.0
        else:
            vmin = float(arr[finite].min())
            vmax = float(arr[finite].max())
        if vmax - vmin < 1e-12:
            vmax = vmin + 1.0   # avoid div-by-zero on constant fields
        q = np.full(arr.shape, 0xFFFF, dtype="<u2")
        q[finite] = np.round((arr[finite] - vmin) / (vmax - vmin) * 65534).astype("<u2")
        compressed = gzip.compress(q.tobytes(), compresslevel=gzip_level)
        out_bytes += len(compressed)
        out_path = bin_path.with_name(bin_path.name + ".gz")
        out_path.write_bytes(compressed)
        bin_path.unlink()       # remove original .bin (replace, in-place)
        tiles[bin_path.stem] = {"vmin": vmin, "vmax": vmax}

    meta["encoding"] = "f16-gz"
    meta["nan_sentinel"] = 65535
    meta["quantization_levels"] = 65535
    meta["tiles"] = tiles
    meta_path.write_text(json.dumps(meta, indent=2))

    elapsed = time.time() - t0
    ratio = in_bytes / max(1, out_bytes)
    LOG.info("done  %-32s  %4d tiles  %6.1f MB → %5.1f MB  (%.1fx)  %.1fs",
             str(var_dir.relative_to(ROOT)),
             len(bin_files), in_bytes / 1e6, out_bytes / 1e6, ratio, elapsed)
    return len(bin_files), in_bytes, out_bytes


def refresh_root_manifest(tiles_root: Path) -> None:
    """Re-pool per-var meta.json into root manifest.json so the new
    encoding flag and per-tile metadata propagate."""
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
    LOG.info("manifest written → %s", tiles_root / "manifest.json")


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()
    tiles_root = Path(args.root) if Path(args.root).is_absolute() else ROOT / args.root
    if not tiles_root.exists():
        LOG.error("tile root not found: %s", tiles_root)
        return 1
    LOG.info("compress  root=%s  level=%d  force=%s",
             tiles_root.relative_to(ROOT) if tiles_root.is_relative_to(ROOT) else tiles_root,
             args.gzip_level, args.force)

    total_tiles = 0
    total_in = 0
    total_out = 0
    for group_dir in sorted(tiles_root.iterdir()):
        if not group_dir.is_dir():
            continue
        if args.group and group_dir.name != args.group:
            continue
        for var_dir in sorted(group_dir.iterdir()):
            if not var_dir.is_dir():
                continue
            if args.var and var_dir.name != args.var:
                continue
            try:
                n, ib, ob = compress_var_dir(var_dir, args.gzip_level, args.force)
                total_tiles += n
                total_in += ib
                total_out += ob
            except Exception as exc:
                LOG.error("FAIL  %s: %s", var_dir.relative_to(ROOT), exc)

    refresh_root_manifest(tiles_root)
    if total_tiles:
        ratio = total_in / max(1, total_out)
        LOG.info("summary  %d tiles  %.1f GB → %.2f GB  (%.1fx)",
                 total_tiles, total_in / 1e9, total_out / 1e9, ratio)
    return 0


if __name__ == "__main__":
    sys.exit(main())
