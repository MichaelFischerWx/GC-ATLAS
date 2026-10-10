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
    ap.add_argument("--slim-manifest", action="store_true",
                    help="omit per-tile vmin/vmax from the root manifest.json (kept in each "
                         "var's meta.json; requires a frontend with lazy per-var metadata)")
    return ap.parse_args()


def _rel(path: Path) -> Path:
    """Repo-relative path for log lines (absolute if outside the repo)."""
    return path.relative_to(ROOT) if path.is_relative_to(ROOT) else path


def encode_f16_gz(arr: np.ndarray, gzip_level: int) -> tuple[bytes, float, float]:
    """Quantize a float32 tile to uint16 over its own [vmin, vmax] and gzip
    it. Returns (gzipped bytes, vmin, vmax)."""
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
    # mtime=0 keeps the gzip header free of a timestamp, so identical input
    # gives byte-identical output (see _write_if_changed).
    return gzip.compress(q.tobytes(), compresslevel=gzip_level, mtime=0), vmin, vmax


def _write_if_changed(path: Path, data: bytes) -> bool:
    """Write `data` unless `path` already holds exactly those bytes. An
    untouched file keeps its mtime, so `gsutil rsync` skips it — before this,
    every monthly refresh re-uploaded the whole ~10 GB per-year tree."""
    if path.exists() and path.stat().st_size == len(data) and path.read_bytes() == data:
        return False
    path.write_bytes(data)
    return True


def compress_var_dir(var_dir: Path, gzip_level: int, force: bool) -> tuple[int, int, int]:
    """Compress every .bin in `var_dir` to .bin.gz. Returns
    (n_tiles_compressed, total_input_bytes, total_output_bytes).
    Updates meta.json in place with encoding + per-tile vmin/vmax.

    Per-tile entries are MERGED into the existing meta["tiles"]: tiles
    encoded by an earlier run (or by add_pressure_levels.py) keep their
    vmin/vmax unless this run re-encodes them, and entries whose .bin.gz is
    gone are pruned. Replacing the dict wholesale is what orphaned the
    1961-1990 per-year tiles in 2026: they stayed on GCS, undecodable.
    """
    meta_path = var_dir / "meta.json"
    if not meta_path.exists():
        LOG.warning("skip  %s (no meta.json)", _rel(var_dir))
        return 0, 0, 0
    meta = json.loads(meta_path.read_text())
    if meta.get("encoding") == "f16-gz" and not force:
        LOG.info("skip  %s (already f16-gz; use --force to redo)", _rel(var_dir))
        return 0, 0, 0

    bin_files = sorted(p for p in var_dir.iterdir() if p.name.endswith(".bin"))

    in_bytes = 0
    out_bytes = 0
    n_written = 0
    tiles: dict[str, dict] = dict(meta.get("tiles") or {})
    t0 = time.time()
    for bin_path in bin_files:
        arr = np.fromfile(bin_path, dtype="<f4")
        in_bytes += arr.nbytes
        compressed, vmin, vmax = encode_f16_gz(arr, gzip_level)
        out_bytes += len(compressed)
        out_path = bin_path.with_name(bin_path.name + ".gz")
        if _write_if_changed(out_path, compressed):
            n_written += 1
        bin_path.unlink()       # remove original .bin (replace, in-place)
        tiles[bin_path.stem] = {"vmin": vmin, "vmax": vmax}

    # Tiles with no metadata entry. Ones that decompress to float32 are
    # legacy add_pressure_levels.py output (raw float32 under a .bin.gz
    # name) — re-encode those. Ones that decompress to uint16 lost their
    # vmin/vmax and can only be recovered by rebuilding from the raw NetCDFs.
    shape = meta.get("shape")
    n_cells = int(np.prod(shape)) if shape else 0
    n_repaired = 0
    orphans: list[str] = []
    for gz_path in sorted(p for p in var_dir.iterdir() if p.name.endswith(".bin.gz")):
        key = gz_path.name[: -len(".bin.gz")]
        if key in tiles:
            continue
        raw = gzip.decompress(gz_path.read_bytes())
        if n_cells and len(raw) == 4 * n_cells:
            compressed, vmin, vmax = encode_f16_gz(np.frombuffer(raw, dtype="<f4"), gzip_level)
            gz_path.write_bytes(compressed)
            tiles[key] = {"vmin": vmin, "vmax": vmax}
            n_repaired += 1
        else:
            orphans.append(key)
    if n_repaired:
        LOG.info("repair %s  %d float32 tile(s) re-encoded as f16-gz",
                 _rel(var_dir), n_repaired)
    if orphans:
        LOG.warning("orphan %s  %d tile(s) have no vmin/vmax and can't be decoded "
                    "(e.g. %s) — rebuild them from the raw NetCDFs",
                    _rel(var_dir), len(orphans), orphans[0])

    tiles = {k: v for k, v in tiles.items() if (var_dir / f"{k}.bin.gz").exists()}
    if not tiles:
        LOG.info("skip  %s (no tiles)", _rel(var_dir))
        return 0, 0, 0

    # Var-level ranges from the per-tile entries (mean and std separately).
    mean_t = [t for k, t in tiles.items() if not k.startswith("std_")]
    std_t = [t for k, t in tiles.items() if k.startswith("std_")]
    if mean_t:
        meta["vmin"] = min(t["vmin"] for t in mean_t)
        meta["vmax"] = max(t["vmax"] for t in mean_t)
    if std_t:
        meta["std_vmin"] = min(t["vmin"] for t in std_t)
        meta["std_vmax"] = max(t["vmax"] for t in std_t)

    meta["encoding"] = "f16-gz"
    meta["nan_sentinel"] = 65535
    meta["quantization_levels"] = 65535
    meta["tiles"] = dict(sorted(tiles.items()))
    meta_path.write_text(json.dumps(meta, indent=2))

    elapsed = time.time() - t0
    ratio = in_bytes / max(1, out_bytes)
    LOG.info("done  %-32s  %4d tiles (%d changed)  %6.1f MB → %5.1f MB  (%.1fx)  %.1fs",
             str(_rel(var_dir)),
             len(bin_files), n_written, in_bytes / 1e6, out_bytes / 1e6, ratio, elapsed)
    return len(bin_files), in_bytes, out_bytes


def refresh_root_manifest(tiles_root: Path, slim: bool = False) -> None:
    """Re-pool per-var meta.json into root manifest.json so the new
    encoding flag and per-tile metadata propagate.

    slim=True leaves the per-tile `tiles` dicts out of the root manifest
    (they stay in each <group>/<var>/meta.json, which the frontend fetches
    lazily). That takes the per-year manifest from ~10-20 MB to well under
    1 MB. Only publish a slim manifest once the deployed frontend supports
    lazy per-var metadata (js/era5.js ensureTileMeta)."""
    groups: dict = {}
    for group_dir in sorted(tiles_root.iterdir()):
        # "__add_" dirs are stale output from build_tiles.py tiling the
        # add_pressure_levels.py sidecars as if they were variables.
        if not group_dir.is_dir() or "__add_" in group_dir.name:
            continue
        vars_: dict = {}
        for var_dir in sorted(group_dir.iterdir()):
            mp = var_dir / "meta.json"
            if mp.exists():
                meta = json.loads(mp.read_text())
                if slim:
                    meta.pop("tiles", None)
                vars_[var_dir.name] = meta
        if vars_:
            groups[group_dir.name] = vars_
    # Compact separators: the root manifest is machine-read on every page
    # load, and pretty-printing the per-year year_months lists ~5x'd it.
    (tiles_root / "manifest.json").write_text(json.dumps({"groups": groups}, separators=(",", ":")))
    LOG.info("manifest written → %s%s", tiles_root / "manifest.json", "  (slim)" if slim else "")


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
        if not group_dir.is_dir() or "__add_" in group_dir.name:
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
                LOG.error("FAIL  %s: %s", _rel(var_dir), exc)

    refresh_root_manifest(tiles_root, slim=args.slim_manifest)
    if total_tiles:
        ratio = total_in / max(1, total_out)
        LOG.info("summary  %d tiles  %.1f GB → %.2f GB  (%.1fx)",
                 total_tiles, total_in / 1e9, total_out / 1e9, ratio)
    return 0


if __name__ == "__main__":
    sys.exit(main())
