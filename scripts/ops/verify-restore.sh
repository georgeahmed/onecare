#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: verify-restore.sh [options] <backup-directory>

Performs an offline validation of a backup by restoring it into a temporary
Docker volume and scratch config directory. No running services are required.

Options:
      --keep-volume        Do not delete the temporary Docker volume
      --volume-prefix STR  Prefix for the temporary volume name
  -h, --help               Show this help message
EOF
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

KEEP_VOLUME=false
VOLUME_PREFIX="verify-restore"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-volume)
      KEEP_VOLUME=true
      shift
      ;;
    --volume-prefix)
      VOLUME_PREFIX="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      BACKUP_DIR="$1"
      shift
      ;;
  esac
done

if [[ -z "${BACKUP_DIR:-}" ]]; then
  echo "ERROR: backup directory is required." >&2
  usage >&2
  exit 1
fi

if [[ ! -d "${BACKUP_DIR}" ]]; then
  echo "ERROR: Backup directory '${BACKUP_DIR}' not found." >&2
  exit 1
fi

BACKUP_ABS="$(cd "${BACKUP_DIR}" && pwd)"
TEMP_VOLUME="${VOLUME_PREFIX}-$(date +%s)"
SCRATCH_DIR="$(mktemp -d)"
START="$(date +%s)"

cleanup() {
  if [[ "${KEEP_VOLUME}" == "false" ]]; then
    docker volume rm "${TEMP_VOLUME}" >/dev/null 2>&1 || true
  else
    echo "ℹ️ Temporary volume retained: ${TEMP_VOLUME}"
  fi
  rm -rf "${SCRATCH_DIR}"
}
trap cleanup EXIT

echo "🧪 Verifying backup at ${BACKUP_ABS}"
docker volume create "${TEMP_VOLUME}" >/dev/null

JETSTREAM_ARCHIVE="${BACKUP_ABS}/nats-jetstream.tar.gz"
if [[ -f "${JETSTREAM_ARCHIVE}" ]]; then
  echo "→ Restoring JetStream archive into temporary volume ${TEMP_VOLUME}"
  docker run --rm \
    -v "${TEMP_VOLUME}":/data \
    -v "${BACKUP_ABS}":/backup \
    alpine:3 \
    sh -c 'rm -rf /data/* && mkdir -p /data && tar xzf /backup/nats-jetstream.tar.gz -C /data'
  docker run --rm \
    -v "${TEMP_VOLUME}":/data \
    alpine:3 \
    sh -c 'echo "   Contents:" && ls -1 /data | head -n 10 && echo "   ..."' || true
else
  echo "WARN: JetStream archive missing; skipping volume verification." >&2
fi

CONFIG_ARCHIVE="${BACKUP_ABS}/config.tar.gz"
if [[ -f "${CONFIG_ARCHIVE}" ]]; then
  echo "→ Extracting config archive to scratch directory"
  mkdir -p "${SCRATCH_DIR}/config"
  tar xzf "${CONFIG_ARCHIVE}" -C "${SCRATCH_DIR}/config"
  echo "   Sample files:"
  find "${SCRATCH_DIR}/config" -maxdepth 1 -type f | head -n 5
else
  echo "INFO: No config archive found in backup (nothing to verify)."
fi

MANIFEST="${BACKUP_ABS}/manifest.json"
if [[ -f "${MANIFEST}" ]]; then
  echo "→ Manifest summary:"
  cat "${MANIFEST}"
else
  echo "INFO: No manifest.json present in backup."
fi

END="$(date +%s)"
echo "✅ Verification completed in $((END - START))s"
