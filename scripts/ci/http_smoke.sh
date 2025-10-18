#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/ci/http_smoke.sh <base-url>" >&2
  exit 1
fi

BASE_URL="${1%/}"
CORRELATION_ID="${CORRELATION_ID:-cd-smoke-$(date +%s)}"

curl --fail --silent --show-error "${BASE_URL}/health"
curl --fail --silent --show-error "${BASE_URL}/ready"

curl --fail --silent --show-error \
  -X POST "${BASE_URL}/safety-check" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer cd-smoke-token' \
  -H "x-request-id: ${CORRELATION_ID}" \
  -H 'x-actor-type: patient' \
  -H 'x-actor-id: smoke-patient' \
  -H 'x-auth-scope: submit triage:submit' \
  -d '{"practiceId":"cd-smoke","patient":{"id":"patient-smoke"},"narrative":"mild headache","channel":"web"}' \
  || {
    echo "::error title=Smoke test failed::Safety-check endpoint returned error"
    exit 1
  }

echo "Smoke checks succeeded for ${BASE_URL}"
