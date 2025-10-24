#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d "team/backend" ]]; then
  echo "[platform-checklist] team/backend not found; skipping check."
  exit 0
fi

missing=()
while IFS= read -r -d '' f; do
  if ! grep -q "^Platform Checklist (pre-flight)" "$f"; then
    missing+=("$f")
  fi
done < <(find team/backend -maxdepth 1 -type f -name 'engineer-*.md' -print0)

if (( ${#missing[@]} > 0 )); then
  echo "[platform-checklist] Missing 'Platform Checklist (pre-flight)' in the following backend engineer files:" >&2
  for f in "${missing[@]}"; do
    echo "  - $f" >&2
  done
  echo "Please add the checklist section (see docs/CONVENTIONS.md: Service Platform Checklist Template)." >&2
  exit 1
fi

echo "[platform-checklist] All backend engineer files contain a Platform Checklist section."
