#!/usr/bin/env python3
"""Slim the Natural Earth GeoJSON the globe draws as coastlines and lakes.

The viewer reads only each feature's geometry (js/globe.js initCoastlines),
so the Natural Earth attribute table, bounding boxes and CRS block are dead
weight, and six-decimal coordinates are far finer than the globe can show:
0.01 deg is about a third of a pixel at the closest zoom. This drops the
former and rounds the latter, which roughly halves the download.

Run it on a fresh Natural Earth export before committing it; it rewrites the
files in place and is a no-op on files it has already slimmed.

    python pipeline/slim_coastlines.py assets/coastlines/*.geojson
"""
import argparse
import json
from pathlib import Path


def slim_line(coords, ndigits):
    """Round a [[lon, lat], ...] line, dropping points that round together."""
    out = []
    for lon, lat, *_ in coords:
        pt = [round(lon, ndigits), round(lat, ndigits)]
        if not out or out[-1] != pt:
            out.append(pt)
    return out


def slim_geometry(geom, ndigits):
    """Return the geometry with rounded coordinates, or None if nothing drawable is left."""
    kind, coords = geom["type"], geom["coordinates"]
    if kind == "LineString":
        lines = slim_line(coords, ndigits)
        keep = len(lines) >= 2
    elif kind in ("MultiLineString", "Polygon"):
        lines = [l for l in (slim_line(c, ndigits) for c in coords) if len(l) >= 2]
        keep = bool(lines)
    elif kind == "MultiPolygon":
        lines = [[l for l in (slim_line(c, ndigits) for c in poly) if len(l) >= 2] for poly in coords]
        lines = [poly for poly in lines if poly]
        keep = bool(lines)
    else:
        return None
    return {"type": kind, "coordinates": lines} if keep else None


def slim_file(path, ndigits):
    before = path.stat().st_size
    src = json.loads(path.read_text(encoding="utf-8"))
    features = []
    for feat in src["features"]:
        geom = slim_geometry(feat["geometry"], ndigits) if feat.get("geometry") else None
        if geom:
            features.append({"type": "Feature", "geometry": geom})
    out = {"type": "FeatureCollection", "features": features}
    path.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{path}: {before:,} -> {path.stat().st_size:,} bytes, "
          f"{len(src['features'])} -> {len(features)} features")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="+", type=Path, help="GeoJSON files to rewrite in place")
    ap.add_argument("--decimals", type=int, default=2,
                    help="coordinate decimals to keep (default 2, about 1 km)")
    args = ap.parse_args()
    for path in args.files:
        slim_file(path, args.decimals)


if __name__ == "__main__":
    main()
