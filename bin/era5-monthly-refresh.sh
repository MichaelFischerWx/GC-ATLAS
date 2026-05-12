#!/bin/bash
#
# era5-monthly-refresh.sh — local monthly refresh for the climatology globe.
#
# Driven by ~/Library/LaunchAgents/com.fischerwx.era5-monthly-refresh.plist
# (10th of each month at 9am local). The pipeline is itself idempotent —
# download_era5.py skips files already on disk, build_tiles.py skips up-to-
# date var dirs, gsutil rsync only uploads new/changed files. So if there's
# no new ERA5 data this month, the run finishes in a few minutes with a
# "no changes" notification and we don't push anything.
#
# Steps:
#   1. probe GCS for the latest tiled (year, month) — establishes a baseline
#   2. download_era5.py             (CDS → data/raw/, data/raw_2021_NNNN/)
#   3. add_pressure_levels.py       (sidecars for 400 + 600 hPa)
#   4. build_tiles.py --per-year    (regenerate per-year tiles)
#   5. build_helmholtz.py --per-year (chi/psi from u, v)
#   6. build_mpi.py    --per-year   (Bister-Emanuel MPI)
#   7. compress_tiles.py            (.bin → .bin.gz with f16 quantization)
#   8. gsutil rsync data/tiles_per_year/ gs://gc-atlas-era5/tiles_per_year/
#   9. probe GCS again, post a macOS notification with the diff
#
# Env: assumes anaconda Python (~/anaconda3) on $PATH and ~/.cdsapirc set up.
#
# Manual extension: era5_variables.yaml's `period` only covers the base
# 1991-2020 climatology. The rolling 2021-NNNN raw dir's name is hard-
# coded in build_tiles.py's auto-detect (raw_2021_2026 today). When ERA5
# lapses into a new year boundary (e.g., into 2027), bump the dir name
# and re-run this script. Search this file for ROLL_PERIOD to update.

set -euo pipefail

ROLL_PERIOD="2021-2026"   # update annually as ERA5 publishes the next year
ROOT="$HOME/github/Gen_Circ"
BUCKET="gs://gc-atlas-era5"
LOG_DIR="$HOME/Library/Logs"
LOG="$LOG_DIR/era5-pipeline.log"
LOCK="/tmp/era5-monthly-refresh.lock"

mkdir -p "$LOG_DIR"

# Block overlapping runs (manual + scheduled, or two scheduled runs after a
# laptop wake catch-up).
exec 9>"$LOCK"
flock -n 9 || { echo "[$(date -u +%FT%TZ)] another era5-monthly-refresh is running — exit" >> "$LOG"; exit 0; }

# Path: anaconda first, then homebrew (for gsutil), then system bins.
export PATH="/opt/anaconda3/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

log() {
    echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"
}

notify() {
    /usr/bin/osascript -e "display notification \"$1\" with title \"ERA5 Pipeline\"" 2>/dev/null || true
}

probe_gcs_latest() {
    /usr/bin/curl -sf "$BUCKET/tiles_per_year/manifest.json" 2>/dev/null \
        | python -c "import json,sys; m=json.load(sys.stdin); ym=m['groups']['single_levels']['sst']['year_months']; y,mn=max(ym); print(f'{y}-{mn:02d}')" \
        2>/dev/null || echo "unknown"
}

cd "$ROOT"
log "=========================================================="
log "era5-monthly-refresh start  (roll period: $ROLL_PERIOD)"

LATEST_BEFORE=$(probe_gcs_latest)
log "GCS latest before: $LATEST_BEFORE"

# 1. download_era5.py
# --incremental: for files already on disk, append only newly-published
# months along the time axis instead of skipping the file outright.
log "1/8  download_era5.py --period $ROLL_PERIOD --incremental"
python pipeline/download_era5.py --period "$ROLL_PERIOD" --incremental >> "$LOG" 2>&1 || {
    log "FAIL: download_era5.py — see log for CDS details"
    notify "ERA5 download failed — check $LOG"
    exit 1
}

# 2. add_pressure_levels.py — add 400/600 hPa sidecar netCDFs and tiles.
# --incremental applies to the sidecar fetch (same skip-bug as download_era5).
log "2/8  add_pressure_levels.py --levels 400,600 --per-year --incremental"
python pipeline/add_pressure_levels.py --levels 400,600 --per-year --incremental >> "$LOG" 2>&1 || {
    log "FAIL: add_pressure_levels.py"
    notify "ERA5 add_pressure_levels failed — check $LOG"
    exit 1
}

# 3. build_tiles.py --per-year --force — rebuild every (year, month) tile.
# --force is required: build_tiles otherwise skips any var dir that already
# exists, so once a tree is on disk it never picks up a new month from the
# extended raw NetCDFs. Deterministic quantization means rsync still skips
# unchanged tiles downstream, so the cost is local CPU only.
log "3/8  build_tiles.py --per-year --force"
python pipeline/build_tiles.py --per-year --force >> "$LOG" 2>&1 || {
    log "FAIL: build_tiles.py"
    notify "ERA5 build_tiles failed — check $LOG"
    exit 1
}

# 4. Helmholtz: chi/psi from u, v. --force for the same reason as build_tiles.
log "4/8  build_helmholtz.py --per-year --force"
python pipeline/build_helmholtz.py --per-year --force >> "$LOG" 2>&1 || {
    log "FAIL: build_helmholtz.py"
    notify "ERA5 helmholtz failed — check $LOG"
    exit 1
}

# 5. MPI via tcpyPI. --force always rebuilds the MPI tree because it depends
# on every component tile and the engine doesn't track its own staleness.
log "5/8  build_mpi.py --per-year --force"
python pipeline/build_mpi.py --per-year --force >> "$LOG" 2>&1 || {
    log "FAIL: build_mpi.py"
    notify "ERA5 build_mpi failed — check $LOG"
    exit 1
}

# 6. Compress the new tiles to f16-gz so they have meta.encoding=='f16-gz'
# and era5.js fetches them at the right URL. --force re-runs through every
# var dir even if meta already says f16-gz, so the new months actually get
# encoded and meta.tiles is repopulated with the full set.
log "6/8  compress_tiles.py --root data/tiles_per_year --force"
python pipeline/compress_tiles.py --root data/tiles_per_year --force >> "$LOG" 2>&1 || {
    log "FAIL: compress_tiles.py"
    notify "ERA5 compress failed — check $LOG"
    exit 1
}

# 7. gsutil rsync — only uploads new / changed files (size + mtime hash).
log "7/8  gsutil rsync data/tiles_per_year/ → $BUCKET/tiles_per_year/"
gsutil -m rsync -r data/tiles_per_year/ "$BUCKET/tiles_per_year/" >> "$LOG" 2>&1 || {
    log "FAIL: gsutil rsync"
    notify "ERA5 GCS upload failed — check $LOG"
    exit 1
}

# 8. Diff before/after to decide what to tell the user.
LATEST_AFTER=$(probe_gcs_latest)
log "GCS latest after:  $LATEST_AFTER"

if [ "$LATEST_BEFORE" = "$LATEST_AFTER" ]; then
    log "DONE  no new ERA5 data this run (still at $LATEST_AFTER)"
    notify "ERA5 pipeline ran — no new data ($LATEST_AFTER)"
else
    log "DONE  tiles advanced $LATEST_BEFORE → $LATEST_AFTER"
    notify "ERA5 tiles updated: $LATEST_BEFORE → $LATEST_AFTER"
fi

log "era5-monthly-refresh end"
