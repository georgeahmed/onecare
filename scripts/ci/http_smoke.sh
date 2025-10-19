#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: http_smoke.sh --base-url URL [--endpoint PATH]... [--expect CODE]

Runs lightweight HTTP checks against the provided base URL. Each endpoint
defaults to `/readyz` and `/healthz` if none are specified.

Options:
  --base-url URL     Base URL (required)
  --endpoint PATH    Endpoint path (may be repeated)
  --expect CODE      Expected HTTP status code (default: 200)
  --timeout SECS     curl timeout (default: 5)
  -h, --help         Show this help
EOF
}

BASE_URL=""
ENDPOINTS=()
EXPECT=200
TIMEOUT=5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --endpoint)
      ENDPOINTS+=("$2")
      shift 2
      ;;
    --expect)
      EXPECT="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BASE_URL" ]]; then
  echo "ERROR: --base-url is required" >&2
  usage >&2
  exit 1
fi

if [[ ${#ENDPOINTS[@]} -eq 0 ]]; then
  ENDPOINTS=(/readyz /healthz)
fi

status=0
for endpoint in "${ENDPOINTS[@]}"; do
  url="${BASE_URL%/}/${endpoint#/}"
  echo "→ Checking ${url}"
  tmp_body=$(mktemp 2>/dev/null || printf '/tmp/http_smoke_%s' "$$")
  http_code=$(curl --fail --silent --show-error --max-time "$TIMEOUT" --write-out '%{http_code}' --output "${tmp_body}" "${url}" || true)
  body=""
  if [[ -f "${tmp_body}" ]]; then
    body=$(cat "${tmp_body}")
    rm -f "${tmp_body}"
  fi
  if [[ "$http_code" != "$EXPECT" ]]; then
    echo "ERROR: ${url} returned status ${http_code}, expected ${EXPECT}" >&2
    echo "Response body: ${body}" >&2
    status=1
  else
    echo "   Status ${http_code} OK"
  fi
done

exit $status
