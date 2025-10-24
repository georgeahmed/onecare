#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: backup.sh [options] [destination]

Options:
  -o, --output DIR        Destination root directory (defaults to ./backups)
  -t, --tag NAME          Optional tag appended to the backup folder name
      --log-file PATH     Append JSON summary to PATH
      --metadata PATH     Write manifest JSON to PATH instead of the backup folder
  -h, --help              Show this help message

Examples:
  bash scripts/ops/backup.sh
  bash scripts/ops/backup.sh --output /mnt/secure --tag nightly
  bash scripts/ops/backup.sh --log-file backups/backup-history.jsonl
EOF
}

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-onecare}"
BACKUP_ROOT="backups"
TAG=""
LOG_FILE=""
MANIFEST_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output)
      BACKUP_ROOT="$2"
      shift 2
      ;;
    -t|--tag)
      TAG="$2"
      shift 2
      ;;
    --log-file)
      LOG_FILE="$2"
      shift 2
      ;;
    --metadata)
      MANIFEST_OVERRIDE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      BACKUP_ROOT="$1"
      shift
      ;;
  esac
done

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="${TIMESTAMP}"
if [[ -n "$TAG" ]]; then
  BACKUP_NAME="${BACKUP_NAME}--${TAG}"
fi
TARGET_DIR="${BACKUP_ROOT}/${BACKUP_NAME}"
START_EPOCH="$(date +%s)"
NATS_VOLUME="${PROJECT_NAME}_nats-data"

mkdir -p "${TARGET_DIR}"
TARGET_ABS="$(cd "${TARGET_DIR}" && pwd)"
echo "📦 Writing backup to ${TARGET_ABS}"

CONFIG_INCLUDED=false
NATS_INCLUDED=false

if docker volume inspect "${NATS_VOLUME}" >/dev/null 2>&1; then
  echo "→ Snapshotting NATS volume ${NATS_VOLUME}"
  docker run --rm \
    -v "${NATS_VOLUME}":/data \
    -v "${TARGET_ABS}":/backup \
    alpine:3 \
    sh -c 'cd /data && tar czf /backup/nats-jetstream.tar.gz .'
  NATS_INCLUDED=true
else
  echo "WARN: NATS volume ${NATS_VOLUME} not found; skipping JetStream backup." >&2
fi

if [[ -d "config" ]]; then
  echo "→ Archiving repo config/ directory"
  tar czf "${TARGET_ABS}/config.tar.gz" -C config .
  CONFIG_INCLUDED=true
else
  echo "WARN: config/ directory missing; skipping config snapshot." >&2
fi

manifest_path="${MANIFEST_OVERRIDE:-${TARGET_ABS}/manifest.json}"
mkdir -p "$(dirname "${manifest_path}")"
END_EPOCH="$(date +%s)"
DURATION="$((END_EPOCH - START_EPOCH))"

checksum_or_empty() {
  local file="$1"
  if [[ -f "$file" ]]; then
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 "$file" | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$file" | awk '{print $1}'
    else
      echo ""
    fi
  else
    echo ""
  fi
}

NATS_ARCHIVE="${TARGET_ABS}/nats-jetstream.tar.gz"
CONFIG_ARCHIVE="${TARGET_ABS}/config.tar.gz"
NATS_SIZE=""
CONFIG_SIZE=""
if [[ -f "$NATS_ARCHIVE" ]]; then
  NATS_SIZE="$(stat -c%s "$NATS_ARCHIVE" 2>/dev/null || stat -f%z "$NATS_ARCHIVE")"
fi
if [[ -f "$CONFIG_ARCHIVE" ]]; then
  CONFIG_SIZE="$(stat -c%s "$CONFIG_ARCHIVE" 2>/dev/null || stat -f%z "$CONFIG_ARCHIVE")"
fi

cat > "${manifest_path}" <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "project": "${PROJECT_NAME}",
  "backup_name": "${BACKUP_NAME}",
  "nats_volume": "${NATS_VOLUME}",
  "config_included": ${CONFIG_INCLUDED},
  "nats_included": ${NATS_INCLUDED},
  "duration_seconds": ${DURATION},
  "artifacts": {
    "nats": {
      "path": "$(basename "${NATS_ARCHIVE}")",
      "size_bytes": ${NATS_SIZE:-null},
      "sha256": "$(checksum_or_empty "${NATS_ARCHIVE}")"
    },
    "config": {
      "path": "$(basename "${CONFIG_ARCHIVE}")",
      "size_bytes": ${CONFIG_SIZE:-null},
      "sha256": "$(checksum_or_empty "${CONFIG_ARCHIVE}")"
    }
  }
}
EOF

if [[ -n "$LOG_FILE" ]]; then
  mkdir -p "$(dirname "$LOG_FILE")"
  cat "${manifest_path}" >> "${LOG_FILE}"
  echo >> "${LOG_FILE}"
fi

echo "✅ Backup complete in ${DURATION}s."
echo "Manifest written to ${manifest_path}"
