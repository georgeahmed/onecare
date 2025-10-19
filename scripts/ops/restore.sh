#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: restore.sh [options] <backup-directory>

Options:
      --volume NAME     Restore into the specified docker volume (defaults to ${COMPOSE_PROJECT_NAME}_nats-data)
      --skip-volume     Do not restore the JetStream volume (config only)
      --skip-config     Do not restore config/ contents
      --dry-run         Validate archives without modifying any state
  -h, --help            Show this message
EOF
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-onecare}"
NATS_VOLUME="${PROJECT_NAME}_nats-data"
RESTORE_VOLUME=true
RESTORE_CONFIG=true
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --volume)
      NATS_VOLUME="$2"
      shift 2
      ;;
    --skip-volume)
      RESTORE_VOLUME=false
      shift
      ;;
    --skip-config)
      RESTORE_CONFIG=false
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
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

echo "Preparing to restore backup from ${BACKUP_DIR}"

if [[ "${DRY_RUN}" == "false" ]] && docker compose ps --status=running --services 2>/dev/null | grep -q '^nats$'; then
  echo "ERROR: docker compose services appear to be running. Please run 'docker compose down' before restoring." >&2
  exit 1
fi

START_EPOCH="$(date +%s)"

JETSTREAM_ARCHIVE="${BACKUP_DIR}/nats-jetstream.tar.gz"
if [[ "${RESTORE_VOLUME}" == "true" ]]; then
  if [[ "${DRY_RUN}" == "true" ]]; then
    if [[ -f "${JETSTREAM_ARCHIVE}" ]]; then
      echo "✔ Verified JetStream archive present (${JETSTREAM_ARCHIVE})"
    else
      echo "WARN: JetStream archive missing; would skip volume restore." >&2
    fi
  else
    if ! docker volume inspect "${NATS_VOLUME}" >/dev/null 2>&1; then
      echo "→ Creating NATS volume ${NATS_VOLUME}"
      docker volume create "${NATS_VOLUME}" >/dev/null
    fi
    if [[ -f "${JETSTREAM_ARCHIVE}" ]]; then
      echo "→ Restoring JetStream data into volume ${NATS_VOLUME}"
      docker run --rm \
        -v "${NATS_VOLUME}":/data \
        -v "${BACKUP_ABS}":/backup \
        alpine:3 \
        sh -c 'rm -rf /data/* && mkdir -p /data && tar xzf /backup/nats-jetstream.tar.gz -C /data'
    else
      echo "WARN: JetStream archive missing; skipping volume restore." >&2
    fi
  fi
fi

CONFIG_ARCHIVE="${BACKUP_DIR}/config.tar.gz"
if [[ "${RESTORE_CONFIG}" == "true" ]]; then
  if [[ "${DRY_RUN}" == "true" ]]; then
    if [[ -f "${CONFIG_ARCHIVE}" ]]; then
      echo "✔ Verified config archive present (${CONFIG_ARCHIVE})"
    else
      echo "INFO: No config archive found; config/ would remain unchanged."
    fi
  else
    if [[ -f "${CONFIG_ARCHIVE}" ]]; then
      echo "→ Restoring config/ directory"
      mkdir -p config
      tar xzf "${CONFIG_ARCHIVE}" -C config
    else
      echo "INFO: No config archive found; leaving config/ unchanged."
    fi
  fi
fi

END_EPOCH="$(date +%s)"
DURATION="$((END_EPOCH - START_EPOCH))"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "✅ Dry-run validation completed in ${DURATION}s."
else
  echo "✅ Restore complete in ${DURATION}s. Restart services with 'docker compose up -d'."
fi
