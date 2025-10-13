#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${1:-}"
HEAD_REF="${2:-}"

if [[ -z "$BASE_REF" || -z "$HEAD_REF" ]]; then
  BASE_REF=$(git rev-parse HEAD^ || echo "")
  HEAD_REF=$(git rev-parse HEAD)
fi

CHANGED=$(git diff --name-only "$BASE_REF" "$HEAD_REF")

# If package.json files or scripts/ changed, require docs/USAGE.md to be touched.
if echo "$CHANGED" | grep -qE '(^|/)package.json$|^scripts/'; then
  if ! echo "$CHANGED" | grep -qE '^docs/USAGE.md$'; then
    echo "ERROR: Command/scripts changed but docs/USAGE.md not updated." >&2
    exit 1
  fi
fi

echo "Docs check passed"
