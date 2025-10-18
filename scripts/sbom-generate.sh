#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="${1:-artifacts/sbom}"
NODE_TARGET="${SBOM_NODE_TARGET:-dir:.}"
PY_TARGET="${SBOM_PY_TARGET:-dir:services-py}"
IFS=' ' read -r -a EXCLUDES <<< "${SBOM_NODE_EXCLUDES:-services-py}"
SYFT_IMAGE="${SYFT_IMAGE:-ghcr.io/anchore/syft:latest}"
FORMAT="${SBOM_FORMAT:-cyclonedx-json}"
EXTENSION="sbom.json"
if [[ "$FORMAT" == "cyclonedx-json" ]]; then
  EXTENSION="cdx.json"
elif [[ "$FORMAT" == "spdx-json" ]]; then
  EXTENSION="spdx.json"
fi

ensure_tools() {
  if command -v syft >/dev/null 2>&1; then
    echo "ℹ️ Using local syft installation"
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    echo "ℹ️ syft not found; falling back to Docker image ${SYFT_IMAGE}"
    return 0
  fi
  echo "ERROR: syft is not installed and Docker is unavailable. Install syft (https://github.com/anchore/syft) or enable Docker." >&2
  exit 1
}

syft_cmd() {
  if command -v syft >/dev/null 2>&1; then
    syft "$@"
  else
    docker run --rm -v "$PWD":/work -w /work "$SYFT_IMAGE" "$@"
  fi
}

write_checksum() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" > "${file}.sha256"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" > "${file}.sha256"
  else
    echo "WARN: sha256 tooling not found; skipping checksum for $file" >&2
  fi
}

mkdir -p "$OUTPUT_DIR"
ensure_tools

NODE_ARGS=("$NODE_TARGET")
for exclude in "${EXCLUDES[@]}"; do
  if [[ -n "$exclude" ]]; then
    NODE_ARGS+=("--exclude" "$exclude")
  fi
done
NODE_ARGS+=("-o" "${FORMAT}=${OUTPUT_DIR}/sbom-node.${EXTENSION}")

echo "▶️ Generating Node.js SBOM → ${OUTPUT_DIR}/sbom-node.${EXTENSION}"
syft_cmd packages "${NODE_ARGS[@]}"
write_checksum "${OUTPUT_DIR}/sbom-node.${EXTENSION}"

echo "▶️ Generating Python SBOM → ${OUTPUT_DIR}/sbom-python.${EXTENSION}"
syft_cmd packages "$PY_TARGET" -o "${FORMAT}=${OUTPUT_DIR}/sbom-python.${EXTENSION}"
write_checksum "${OUTPUT_DIR}/sbom-python.${EXTENSION}"

echo "✅ SBOMs written to ${OUTPUT_DIR}"
