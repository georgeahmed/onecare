#!/usr/bin/env bash
set -euo pipefail

# Restore helper for local/dev environments.
# Applies a backup folder created by backup.sh back onto the NATS JetStream volume and config/.

if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <backup-directory>" >&2
  exit 1
fi

BACKUP_DIR="$1"
if [[ ! -d "${BACKUP_DIR}" ]]; then
  echo "ERROR: Backup directory '${BACKUP_DIR}' not found." >&2
  exit 1
fi
BACKUP_ABS="$(cd "${BACKUP_DIR}" && pwd)"

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-onecare}"
NATS_VOLUME="${PROJECT_NAME}_nats-data"

echo "Preparing to restore backup from ${BACKUP_DIR}"

if docker compose ps --status=running --services 2>/dev/null | grep -q '^nats$'; then
  echo "ERROR: docker compose services appear to be running. Please run 'docker compose down' before restoring." >&2
  exit 1
fi

if ! docker volume inspect "${NATS_VOLUME}" >/dev/null 2>&1; then
  echo "→ Creating NATS volume ${NATS_VOLUME}"
  docker volume create "${NATS_VOLUME}" >/dev/null
fi

JETSTREAM_ARCHIVE="${BACKUP_DIR}/nats-jetstream.tar.gz"
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

CONFIG_ARCHIVE="${BACKUP_DIR}/config.tar.gz"
if [[ -f "${CONFIG_ARCHIVE}" ]]; then
  echo "→ Restoring config/ directory"
  mkdir -p config
  tar xzf "${CONFIG_ARCHIVE}" -C config
else
  echo "INFO: No config archive found; leaving config/ unchanged."
fi

echo "✅ Restore complete. Restart services with 'docker compose up -d'."
