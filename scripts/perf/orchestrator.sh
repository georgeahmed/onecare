#!/usr/bin/env bash
set -euo pipefail

# Simple perf harness for /safety-check. Requires orchestrator running locally.
# Usage: scripts/perf/orchestrator.sh [concurrency]

URL="${URL:-http://localhost:3001/safety-check}"
CONCURRENCY="${1:-10}"

PAYLOAD='{"practiceId":"p1","patient":{"id":"123"},"narrative":"cough","channel":"web"}'
AUTHORIZATION_VALUE="${AUTHORIZATION_VALUE:-Bearer perf-token}"
ACTOR_TYPE_VALUE="${ACTOR_TYPE_VALUE:-system}"
ACTOR_ID_VALUE="${ACTOR_ID_VALUE:-perf-client}"
REQUEST_ID_VALUE="${REQUEST_ID_VALUE:-perf-$(date +%s)}"
AUTH_SCOPE_VALUE="${AUTH_SCOPE_VALUE:-submit triage:submit}"

echo "Hitting ${URL} with concurrency=${CONCURRENCY} for 30s"
npx --yes autocannon \
  -c "${CONCURRENCY}" \
  -d 30 \
  -m POST \
  -H 'content-type: application/json' \
  -H "authorization: ${AUTHORIZATION_VALUE}" \
  -H "x-actor-type: ${ACTOR_TYPE_VALUE}" \
  -H "x-actor-id: ${ACTOR_ID_VALUE}" \
  -H "x-request-id: ${REQUEST_ID_VALUE}" \
  -H "x-auth-scope: ${AUTH_SCOPE_VALUE}" \
  -b "${PAYLOAD}" \
  "${URL}"
