#!/usr/bin/env bash
set -euo pipefail

# Fetch an OAuth2 access token (client_credentials) for the NHS Sandbox
# Reads configuration from environment variables or flags and optionally
# writes the token to .env.dev as FHIR_SYSTEM_TOKEN.
#
# Env vars (or flags) expected:
#   OIDC_TOKEN_URL  – Full token endpoint. If unset, derived from OIDC_ISSUER
#   OIDC_ISSUER     – Issuer base; token URL becomes "$OIDC_ISSUER/protocol/openid-connect/token"
#   FHIR_CLIENT_ID  – OAuth2 client id
#   FHIR_CLIENT_SECRET – OAuth2 client secret
#   FHIR_TOKEN_SCOPE – Scope string (optional; e.g., "system/*.*" or provider docs)
#   OUT_ENV_FILE    – Target env file to write (default .env.dev) when --write-env
#
# Usage examples:
#   FHIR_CLIENT_ID=xxx FHIR_CLIENT_SECRET=yyy OIDC_ISSUER=https://identity.ptl.api.platform.nhs.uk/realms/NHS-Login-mock-int \
#     scripts/dev/fetch-nhs-token.sh --print
#
#   export FHIR_TOKEN_SCOPE="system/*.*"
#   scripts/dev/fetch-nhs-token.sh --write-env

print_only=false
write_env=false
scope=${FHIR_TOKEN_SCOPE:-}
out_env_file=${OUT_ENV_FILE:-.env.dev}
issuer=${OIDC_ISSUER:-}
token_url=${OIDC_TOKEN_URL:-}
client_id=${FHIR_CLIENT_ID:-}
client_secret=${FHIR_CLIENT_SECRET:-}

usage() {
  cat <<EOF
Usage: ${0##*/} [--print|--write-env] [--scope S]

Options:
  --print         Print token to stdout only
  --write-env     Write token into ".env.dev" (or OUT_ENV_FILE) as FHIR_SYSTEM_TOKEN
  --scope S       Override scope (defaults to FHIR_TOKEN_SCOPE if set)

Requires env: FHIR_CLIENT_ID, FHIR_CLIENT_SECRET, and either OIDC_TOKEN_URL or OIDC_ISSUER
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print) print_only=true; shift ;;
    --write-env) write_env=true; shift ;;
    --scope) scope="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$token_url" ]]; then
  if [[ -z "$issuer" ]]; then
    echo "ERROR: set OIDC_TOKEN_URL or OIDC_ISSUER" >&2
    exit 1
  fi
  token_url="${issuer%/}/protocol/openid-connect/token"
fi

if [[ -z "$client_id" || -z "$client_secret" ]]; then
  echo "ERROR: FHIR_CLIENT_ID and FHIR_CLIENT_SECRET are required" >&2
  exit 1
fi

# Build form data
form=(
  -d "grant_type=client_credentials"
  -d "client_id=$client_id"
  -d "client_secret=$client_secret"
)
if [[ -n "$scope" ]]; then
  form+=( -d "scope=$scope" )
fi

resp_json=$(curl -sS -X POST "$token_url" \
  -H 'content-type: application/x-www-form-urlencoded' \
  "${form[@]}")

# Extract token without requiring jq
token=$(python3 - <<'PY'
import json,sys
try:
    data=json.load(sys.stdin)
    print(data.get('access_token',''))
except Exception:
    print('')
PY
<<<"$resp_json")

if [[ -z "$token" ]]; then
  echo "ERROR: failed to obtain access_token. Response was:" >&2
  echo "$resp_json" >&2
  exit 1
fi

if $print_only && ! $write_env; then
  echo "$token"
  exit 0
fi

# Write to env file as FHIR_SYSTEM_TOKEN
touch "$out_env_file"
if grep -q '^FHIR_SYSTEM_TOKEN=' "$out_env_file"; then
  # Replace in-place (portable sed)
  tmp=$(mktemp)
  sed "s|^FHIR_SYSTEM_TOKEN=.*$|FHIR_SYSTEM_TOKEN=$token|" "$out_env_file" > "$tmp"
  mv "$tmp" "$out_env_file"
else
  printf "\nFHIR_SYSTEM_TOKEN=%s\n" "$token" >> "$out_env_file"
fi

echo "Wrote FHIR_SYSTEM_TOKEN to $out_env_file"
echo "Tip: source it via: set -a; source $out_env_file; set +a"

