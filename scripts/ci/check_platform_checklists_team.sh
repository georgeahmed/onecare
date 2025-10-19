#!/usr/bin/env bash
set -euo pipefail

TEAM_DIR=${1:-}
STRICT=${STRICT:-0}

if [[ -z "$TEAM_DIR" ]]; then
  echo "Usage: $0 team/<folder> [STRICT=1]" >&2
  exit 2
fi

if [[ ! -d "$TEAM_DIR" ]]; then
  echo "[platform-checklist] Team dir not found: $TEAM_DIR (skipping)." >&2
  exit 0
fi

missing=()
while IFS= read -r -d '' f; do
  if ! grep -q "^Platform Checklist (pre-flight)" "$f"; then
    missing+=("$f")
  fi
done < <(find "$TEAM_DIR" -maxdepth 1 -type f -name 'engineer-*.md' -print0)

if (( ${#missing[@]} > 0 )); then
  echo "[platform-checklist][$TEAM_DIR] Missing 'Platform Checklist (pre-flight)' in:" >&2
  for f in "${missing[@]}"; do
    echo "  - $f" >&2
  done
  echo "See docs/CONVENTIONS.md (Service Platform Checklist Template)." >&2
  if [[ "$STRICT" == "1" ]]; then
    exit 1
  else
    exit 0
  fi
fi

echo "[platform-checklist][$TEAM_DIR] OK"
