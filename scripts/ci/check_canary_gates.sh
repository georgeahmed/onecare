#!/usr/bin/env bash
set -euo pipefail

PSI=${CANARY_PSI:-}
JS=${CANARY_JS:-}
FRESHNESS=${CANARY_FRESHNESS_MS:-}
SHADOW=${CANARY_SHADOW_AGREEMENT:-}

if [[ -n "${CANARY_OVERRIDE_REASON:-}" ]]; then
  echo "::warning title=Canary Gates::Bypassing gates due to override: ${CANARY_OVERRIDE_REASON}" >&2
  exit 0
fi

if [[ -z "$PSI" || -z "$JS" || -z "$FRESHNESS" || -z "$SHADOW" ]]; then
  echo "Missing canary metrics (CANARY_PSI, CANARY_JS, CANARY_FRESHNESS_MS, CANARY_SHADOW_AGREEMENT)." >&2
  echo "Set metrics or provide CANARY_OVERRIDE_REASON to bypass." >&2
  exit 1
fi

python3 - "$PSI" "$JS" "$FRESHNESS" "$SHADOW" <<'PY'
import sys
from typing import Any

def to_float(value: Any) -> float:
    if value is None:
        raise ValueError("missing value")
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.strip().lower()
        for suffix in ('ms', '%'):
            if cleaned.endswith(suffix):
                cleaned = cleaned[: -len(suffix)]
        cleaned = cleaned.strip()
        if not cleaned:
            raise ValueError(f"empty numeric value: {value!r}")
        return float(cleaned)
    raise TypeError(f"unsupported metric type {type(value)!r}")

psi, js, freshness, shadow = (to_float(arg) for arg in sys.argv[1:])
errors = []
if psi > 0.3:
    errors.append(f"psi {psi:.3f} exceeds 0.3")
if js > 0.2:
    errors.append(f"js {js:.3f} exceeds 0.2")
if freshness > 180000:  # 3 minutes
    errors.append(f"freshness {freshness:.0f}ms exceeds 180000ms")
if shadow < 0.985:
    errors.append(f"shadow agreement {shadow:.3f} below 0.985")
if errors:
    for err in errors:
        print(err, file=sys.stderr)
    sys.exit(1)
print("Canary gates satisfied")
PY
