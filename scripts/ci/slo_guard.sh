#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SLO_FILE="${ROOT_DIR}/docs/observability/SLOs.md"

if [[ ! -f "${SLO_FILE}" ]]; then
  echo "::error title=SLO guard::docs/observability/SLOs.md is missing"
  exit 1
fi

CONTENT=$(sed -e 's/^[[:space:]]*//' "${SLO_FILE}" | tr '[:upper:]' '[:lower:]')

check_section() {
  local keyword="$1"
  if ! grep -q "${keyword}" <<<"${CONTENT}"; then
    echo "::error title=SLO guard::Missing required SLO section for '${keyword}' in docs/observability/SLOs.md"
    exit 1
  fi
}

check_section "triage"
check_section "scribe"
check_section "uptime"

echo "SLO guard passed: docs/observability/SLOs.md present with required sections."
