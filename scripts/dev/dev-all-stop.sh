#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
PIDS_DIR="$ROOT_DIR/.dev-all/pids"

stop_pid_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid=$(cat "$file" 2>/dev/null || true)
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  fi
}

if [[ -d "$PIDS_DIR" ]]; then
  for f in "$PIDS_DIR"/*.pid; do
    [[ -e "$f" ]] || continue
    stop_pid_file "$f"
  done
  rmdir "$PIDS_DIR" 2>/dev/null || true
fi

echo "[dev-all] Stopped processes."

