#!/usr/bin/env bash
set -euo pipefail

SCENARIO=${1:-all}
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
CMD=(npm run test:e2e -- --run qa/e2e/chaos/system-chaos.spec.ts)

case "$SCENARIO" in
  bus)
    CMD+=(--testNamePattern "bus outage")
    ;;
  fhir)
    CMD+=(--testNamePattern "FHIR circuit")
    ;;
  all)
    ;;
  *)
    echo "Usage: $0 [all|bus|fhir]" >&2
    exit 1
    ;;
 esac

( cd "$ROOT_DIR" && NODE_ENV=test "${CMD[@]}" )
