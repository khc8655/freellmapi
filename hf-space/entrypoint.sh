#!/usr/bin/env bash
# =============================================================================
# FreeLLMAPI — HuggingFace Space Entrypoint (Stateless Sync Version)
# =============================================================================
set -euo pipefail

# ---------- Paths ------------------------------------------------------------
LOCAL_DB="/app/data/freeapi.db"
BACKUP_DIR="/data/freellmapi_backup"

# ---------- Environment ------------------------------------------------------
export PORT="${PORT:-7860}"
export HOST="${HOST:-0.0.0.0}"
export FREEAPI_DB_PATH="$LOCAL_DB"

# Ensure local data directory exists
mkdir -p /app/data

# =============================================================================
# PHASE 1 — Restore: pull backup from /data → local before server starts
# =============================================================================
if [ -d /data ] && [ -f "$BACKUP_DIR/freeapi.db" ]; then
    echo "[HF-Sync] Persistent storage found. Restoring database..."
    cp --no-preserve=ownership "$BACKUP_DIR/freeapi.db" "$LOCAL_DB"
    echo "[HF-Sync] Database restored successfully ($(du -sh "$LOCAL_DB" | cut -f1))."
else
    echo "[HF-Sync] No backup found — starting fresh database."
fi

# =============================================================================
# PHASE 2 — Define the sync function (Runs ONLY on exit/SIGTERM)
# =============================================================================
_sync_to_storage() {
    [ -d /data ] || return 0
    [ -f "$LOCAL_DB" ] || return 0

    echo "[HF-Sync] Syncing database to persistent storage..."
    mkdir -p "$BACKUP_DIR"
    
    # Simple copy since the database has virtually NO writes during runtime,
    # meaning there are no WAL locking conflicts anymore.
    cp --no-preserve=ownership "$LOCAL_DB" "$BACKUP_DIR/freeapi.db"
    echo "[HF-Sync] ✓ Synced to persistent storage."
}

# =============================================================================
# PHASE 3 — SIGTERM handler: emergency sync on shutdown
# =============================================================================
_graceful_shutdown() {
    echo "[HF-Sync] SIGTERM received — performing emergency sync before exit..."
    _sync_to_storage || echo "[HF-Sync] Warning: emergency sync failed."
    if [ -n "${SERVER_PID:-}" ]; then
        kill -TERM "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    echo "[HF-Sync] Shutdown complete."
    exit 0
}
trap _graceful_shutdown SIGTERM SIGINT

# =============================================================================
# PHASE 4 — One-off initial backup (10 minutes after startup)
# =============================================================================
if [ -d /data ]; then
    (
        # Wait 10 min for server to initialize and keys to be entered
        sleep 600
        _sync_to_storage || true
    ) &
fi

# =============================================================================
# PHASE 5 — Start the FreeLLMAPI server
# =============================================================================
echo "[HF-Sync] Starting FreeLLMAPI server on port $PORT..."
node /app/server/dist/index.js &
SERVER_PID=$!

wait "$SERVER_PID"
