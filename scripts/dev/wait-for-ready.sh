#!/usr/bin/env bash
set -euo pipefail

NAME=""
URL=""
PID_FILE=""
TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-30}"

usage() {
  echo "Usage: $0 --name LABEL --url URL --pid-file PATH [--timeout SECONDS]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      NAME="$2"
      shift 2
      ;;
    --url)
      URL="$2"
      shift 2
      ;;
    --pid-file)
      PID_FILE="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 64
      ;;
  esac
done

if [[ -z "$NAME" || -z "$URL" || -z "$PID_FILE" ]]; then
  echo "Missing required arguments." >&2
  usage
  exit 64
fi

if ! [[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Invalid timeout: $TIMEOUT_SECONDS" >&2
  exit 64
fi

interactive=false
if [[ -t 0 ]]; then
  interactive=true
fi

start=$(date +%s)
poll() {
  if curl -sf "$URL" >/dev/null; then
    return 0
  fi
  return 1
}

process_is_alive() {
  local pid
  if [[ ! -f "$PID_FILE" ]]; then
    # Process may not have written its PID yet; treat as alive until timeout hits
    return 0
  fi
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -z "$pid" ]]; then
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  return 1
}

while true; do
  if poll; then
    exit 0
  fi

  if ! process_is_alive; then
    echo "[dev] $NAME process exited early. Aborting." >&2
    exit 10
  fi

  now=$(date +%s)
  elapsed=$((now - start))
  if (( elapsed >= TIMEOUT_SECONDS )); then
    echo "[dev] $NAME not ready after ${TIMEOUT_SECONDS}s." >&2
    if $interactive; then
      read -r -p "Continue waiting? [y/N] " answer
      case "$answer" in
        [Yy]*)
          start=$(date +%s)
          continue
          ;;
        *)
          exit 11
          ;;
      esac
    else
      exit 11
    fi
  fi

  sleep 0.5
done
