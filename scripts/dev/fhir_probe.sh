#!/usr/bin/env bash
set -euo pipefail

# Probe a FHIR base URL using optional Bearer token and APIM subscription key.
# Uses env vars if present:
#   FHIR_BASE_URL (required)
#   FHIR_TOKEN or FHIR_SYSTEM_TOKEN (optional)
#   FHIR_API_KEY_HEADER (default: apikey)
#   FHIR_API_KEY (optional)

base=${FHIR_BASE_URL:-}
if [[ -z "$base" ]]; then
  echo "ERROR: FHIR_BASE_URL is required" >&2
  exit 1
fi

tok=${FHIR_TOKEN:-${FHIR_SYSTEM_TOKEN:-}}
key_hdr=${FHIR_API_KEY_HEADER:-apikey}
key_val=${FHIR_API_KEY:-}

args=( -sS -D - )
[[ -n "$tok" ]] && args+=( -H "Authorization: Bearer $tok" )
[[ -n "$key_val" ]] && args+=( -H "$key_hdr: $key_val" )

echo "Probing $base/metadata ..." >&2
curl "${args[@]}" "$base/metadata" -o /dev/null | awk 'NR==1{print}'

