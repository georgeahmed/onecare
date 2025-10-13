#!/usr/bin/env bash
set -euo pipefail

# Simple backup helper for local/dev environments.
# Captures NATS JetStream data and config/ manifests into a timestamped folder.

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-onecare}"
BACKUP_ROOT="${1:-backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
NATS_VOLUME="${PROJECT_NAME}_nats-data"

mkdir -p "${TARGET_DIR}"
TARGET_ABS="$(cd "${TARGET_DIR}" && pwd)"
echo "📦 Writing backup to ${TARGET_ABS}"

CONFIG_INCLUDED=false
if docker volume inspect "${NATS_VOLUME}" >/dev/null 2>&1; then
  echo "→ Snapshotting NATS volume ${NATS_VOLUME}"
  docker run --rm \
    -v "${NATS_VOLUME}":/data \
    -v "${TARGET_ABS}":/backup \
    alpine:3 \
    sh -c 'cd /data && tar czf /backup/nats-jetstream.tar.gz .'
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

cat > "${TARGET_ABS}/manifest.json" <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "project": "${PROJECT_NAME}",
  "nats_volume": "${NATS_VOLUME}",
  "config_included": ${CONFIG_INCLUDED}
}
EOF

echo "✅ Backup complete."
