#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${1:-}"
HEAD_REF="${2:-}"

if [[ -z "$BASE_REF" || -z "$HEAD_REF" ]]; then
  echo "Usage: check_contracts_sync.sh <BASE_SHA> <HEAD_SHA>" >&2
  echo "Falling back to HEAD^ -> HEAD" >&2
  BASE_REF=$(git rev-parse HEAD^ || echo "")
  HEAD_REF=$(git rev-parse HEAD)
fi

if [[ -z "$BASE_REF" ]]; then
  echo "Could not determine base ref; skipping contracts sync check." >&2
  exit 0
fi

CHANGED_FILES=$(git diff --name-only "$BASE_REF" "$HEAD_REF")
SCHEMA_CHANGES=$(echo "$CHANGED_FILES" | grep -E '^schemas/.*\.json$' || true)

if [[ -z "$SCHEMA_CHANGES" ]]; then
  echo "No schema changes detected; contracts sync check skipped."
  exit 0
fi

echo "Schema changes detected; verifying generated contracts updated..."

TS_CONTRACTS_CHANGED=$(echo "$CHANGED_FILES" | grep -E '^packages/.+/src/contracts/' || true)
PY_CONTRACTS_CHANGED=$(echo "$CHANGED_FILES" | grep -E '^services-py/common/contracts/models.py$' || true)

MISSING_OUTPUTS=()

if [[ -z "$TS_CONTRACTS_CHANGED" ]]; then
  MISSING_OUTPUTS+=('packages/*/src/contracts (TypeScript)')
fi

if [[ -z "$PY_CONTRACTS_CHANGED" ]]; then
  MISSING_OUTPUTS+=('services-py/common/contracts/models.py (Python)')
fi

if [[ ${#MISSING_OUTPUTS[@]} -gt 0 ]]; then
  echo "ERROR: Changes under schemas/ require regenerating generated contracts." >&2
  printf 'Missing updates in: %s\n' "${MISSING_OUTPUTS[@]}" >&2
  exit 1
fi

echo "Contracts appear updated alongside schema changes."
exit 0
