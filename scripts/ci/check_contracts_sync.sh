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

if ! echo "$CHANGED_FILES" | grep -qE '^schemas/'; then
  echo "No schema changes detected; contracts sync check skipped."
  exit 0
fi

echo "Schema changes detected; verifying generated contracts updated..."

TS_CONTRACTS_CHANGED=$(echo "$CHANGED_FILES" | grep -E '^packages/events/src/contracts/' || true)
PY_CONTRACTS_CHANGED=$(echo "$CHANGED_FILES" | grep -E '^services-py/common/contracts/models.py$' || true)

if [[ -z "$TS_CONTRACTS_CHANGED" || -z "$PY_CONTRACTS_CHANGED" ]]; then
  echo "ERROR: Changes under schemas/ require regenerating TS and Python contracts." >&2
  echo "Missing updates in: packages/events/src/contracts and/or services-py/common/contracts/models.py" >&2
  exit 1
fi

echo "Contracts appear updated alongside schema changes."
exit 0

