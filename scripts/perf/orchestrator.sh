#!/usr/bin/env bash
set -euo pipefail

# Simple perf harness for /safety-check. Requires orchestrator running locally.
# Usage: scripts/perf/orchestrator.sh [concurrency]

URL="${URL:-http://localhost:3001/safety-check}"
CONCURRENCY="${1:-10}"

PAYLOAD='{"practiceId":"p1","patient":{"id":"123"},"narrative":"cough","channel":"web"}'

echo "Hitting ${URL} with concurrency=${CONCURRENCY} for 30s"
npx --yes autocannon -c "${CONCURRENCY}" -d 30 -m POST -H 'content-type: application/json' -b "${PAYLOAD}" "${URL}"

