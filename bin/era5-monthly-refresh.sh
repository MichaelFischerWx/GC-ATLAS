#!/bin/bash
#
# era5-monthly-refresh.sh — local monthly refresh for the climatology globe.
#
# Driven by ~/Library/LaunchAgents/com.fischerwx.era5-monthly-refresh.plist
# (10th of each month at 9am local). The pipeline is itself idempotent —
# download_era5.py appends only newly published months, compress_tiles.py
# leaves byte-identical tiles untouched (so their mtimes don't change), and
# gsutil rsync then uploads only new/changed tiles. If there's no new ERA5
# data this month the run finishes with a "no new data" notification.
#
# Steps:
#   0. roll the 2021-YYYY raw dir forward at a year boundary (see below)
#   1. download_era5.py             (CDS → data/raw_2021_YYYY/, incremental)
#   2. build_tiles.py --per-year    (per-year tiles, 1961 → present)
#   3. build_helmholtz.py --per-year (chi/psi from u, v)
#   4. add_pressure_levels.py       (400 + 600 hPa sidecars; MPI needs them)
#   5. build_mpi.py    --per-year   (Bister-Emanuel MPI)
#   6. compress_tiles.py            (.bin → .bin.gz, f16 quantization)
#   7. validate_manifest.py         (refuse to publish a regressed tree)
#   8. gsutil rsync tiles, then the manifest last (so clients never see a
#      manifest that points at tiles not uploaded yet)
#   9. update_indices.py + upload data/indices.json (composite builder)
#  10. probe GCS again, post a macOS notification with the diff
#
# Env: assumes anaconda Python (/opt/anaconda3) on $PATH and ~/.cdsapirc.
#
# Year boundary: recent years live in one rolling dir, data/raw_2021_YYYY,
# whose name tracks the current year. On the first run of a new year the
# dir is renamed (raw_2021_2026 → raw_2021_2027) and the incremental
# download appends the new months. Renaming instead of starting a second
# dir matters: two overlapping raw_2021_* dirs would both be merged into
# the per-year tree and break the time axis.

set -euo pipefail

ROLL_START=2021
ROLL_END=$(date +%Y)
ROLL_PERIOD="${ROLL_START}-${ROLL_END}"
ROOT="$HOME/github/Gen_Circ"
BUCKET="gs://gc-atlas-era5"
PUBLIC="https://storage.googleapis.com/gc-atlas-era5"
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

fail() {
    log "FAIL: $1"
    notify "ERA5 refresh failed at $1 — check $LOG"
    exit 1
}

# Latest (year-month) in the PUBLISHED per-year manifest. Must go through
# the public HTTPS endpoint — curl can't fetch gs:// URLs (it used to try,
# so every notification said "still at unknown").
probe_gcs_latest() {
    /usr/bin/curl -sf --compressed "$PUBLIC/tiles_per_year/manifest.json" 2>/dev/null \
        | python -c "import json,sys; m=json.load(sys.stdin); ym=m['groups']['single_levels']['sst']['year_months']; y,mn=max(ym); print(f'{y}-{mn:02d}')" \
        2>/dev/null || echo "unknown"
}

cd "$ROOT"
log "=========================================================="
log "era5-monthly-refresh start  (roll period: $ROLL_PERIOD)"

LATEST_BEFORE=$(probe_gcs_latest)
log "GCS latest before: $LATEST_BEFORE"

# 0. Roll the rolling raw dir forward at a year boundary.
ROLL_DIR="data/raw_${ROLL_START}_${ROLL_END}"
if [ ! -d "$ROLL_DIR" ]; then
    PREV_DIR=$(ls -d data/raw_${ROLL_START}_[0-9][0-9][0-9][0-9] 2>/dev/null | sort | tail -1 || true)
    if [ -n "$PREV_DIR" ]; then
        log "0/9  rename $PREV_DIR → $ROLL_DIR (new year)"
        mv "$PREV_DIR" "$ROLL_DIR"
    fi
fi

# 1. download_era5.py
# --incremental: for files already on disk, append only newly-published
# months along the time axis instead of skipping the file outright.
log "1/9  download_era5.py --period $ROLL_PERIOD --incremental"
python pipeline/download_era5.py --period "$ROLL_PERIOD" --incremental >> "$LOG" 2>&1 \
    || fail "download_era5.py (CDS) — see log"

# 2. build_tiles.py --per-year --force — rebuild every (year, month) tile.
# --force is required: build_tiles otherwise skips any var dir that already
# exists, so it would never pick up a new month from the extended NetCDFs.
# Unchanged tiles come out byte-identical and are not re-uploaded.
log "2/9  build_tiles.py --per-year --force"
python pipeline/build_tiles.py --per-year --force >> "$LOG" 2>&1 || fail "build_tiles.py"

# 3. Helmholtz: chi/psi from u, v. --force for the same reason as build_tiles.
log "3/9  build_helmholtz.py --per-year --force"
python pipeline/build_helmholtz.py --per-year --force >> "$LOG" 2>&1 || fail "build_helmholtz.py"

# 4. add_pressure_levels.py — 400/600 hPa sidecar netCDFs (+ tiles). Runs
# after build_tiles so its `levels` update on each meta.json isn't
# overwritten; MPI (step 5) reads the sidecar netCDFs directly.
log "4/9  add_pressure_levels.py --levels 400,600 --per-year --incremental"
python pipeline/add_pressure_levels.py --levels 400,600 --per-year --incremental >> "$LOG" 2>&1 \
    || fail "add_pressure_levels.py"

# 5. MPI via tcpyPI. --force always rebuilds the MPI tree because it depends
# on every component tile and the engine doesn't track its own staleness.
log "5/9  build_mpi.py --per-year --force"
python pipeline/build_mpi.py --per-year --force >> "$LOG" 2>&1 || fail "build_mpi.py"

# 6. Compress new .bin tiles to f16-gz. --force walks every var dir; per-tile
# metadata is merged (not replaced), so tiles not rebuilt this run keep it.
log "6/9  compress_tiles.py --root data/tiles_per_year --force"
python pipeline/compress_tiles.py --root data/tiles_per_year --force >> "$LOG" 2>&1 \
    || fail "compress_tiles.py"

# 7. Refuse to publish a tree that lost years, months, or decode metadata.
NOT_BEFORE_ARGS=()
if [ "$LATEST_BEFORE" != "unknown" ]; then NOT_BEFORE_ARGS=(--not-before "$LATEST_BEFORE"); fi
log "7/9  validate_manifest.py"
python pipeline/validate_manifest.py --root data/tiles_per_year --min-first-year 1961 \
    "${NOT_BEFORE_ARGS[@]+"${NOT_BEFORE_ARGS[@]}"}" >> "$LOG" 2>&1 \
    || fail "validate_manifest.py (nothing uploaded)"

# 8. Upload tiles (new / changed only), then the manifest last. -q keeps
# per-file progress bars out of the log. The manifest goes up gzip-encoded
# (-Z: ~6x smaller on the wire, browsers decode transparently) with a short
# must-revalidate cache so clients pick up new months quickly.
log "8/9  gsutil rsync data/tiles_per_year/ → $BUCKET/tiles_per_year/"
gsutil -q -m rsync -r -x '.*__add_.*|manifest\.json$' \
    data/tiles_per_year/ "$BUCKET/tiles_per_year/" >> "$LOG" 2>&1 || fail "gsutil rsync"
gsutil -q -h "Cache-Control:public,max-age=300,must-revalidate" \
    cp -Z data/tiles_per_year/manifest.json "$BUCKET/tiles_per_year/manifest.json" >> "$LOG" 2>&1 \
    || fail "manifest upload"

# 9. Climate indices for the composite builder. Non-fatal: a provider being
# down shouldn't block a tile refresh. The frontend reads indices.json from
# the bucket (falling back to the copy in the repo).
log "9/9  update_indices.py"
if python pipeline/update_indices.py >> "$LOG" 2>&1; then
    gsutil -q -h "Cache-Control:public,max-age=300,must-revalidate" \
        cp -Z data/indices.json "$BUCKET/indices.json" >> "$LOG" 2>&1 \
        || log "WARN: indices.json upload failed"
else
    log "WARN: update_indices.py failed — indices.json not refreshed"
fi

# 10. Diff before/after to decide what to tell the user.
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
