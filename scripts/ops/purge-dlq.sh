#!/usr/bin/env bash

set -euo pipefail

DEFAULT_SPOOL="${DLQ_SPOOL:-var/dlq}"
DEFAULT_RETENTION_DAYS="${RETENTION_DAYS:-30}"
DEFAULT_ARCHIVE_DIR="${ARCHIVE_DIR:-archives/dlq}"
DEFAULT_STREAM="${DLQ_STREAM:-broker.dlq}"

usage() {
  cat <<'EOF'
Usage: purge-dlq.sh [options]

Archive and purge DLQ artefacts older than the configured retention window.
Supports file-based spools as well as JetStream streams via the `nats` CLI.

Options:
  --spool PATH              Directory containing DLQ payloads (default: var/dlq)
  --stream NAME             JetStream stream to purge (enables JetStream mode)
  --nats-url URL            NATS JetStream URL (default: value of $NATS_URL or nats://127.0.0.1:4222)
  -d, --retention-days N    Retention window in days (default: 30)
  -a, --archive-dir PATH    Directory to store archived payloads (default: ./archives/dlq)
  --batch-size N            Number of messages to inspect per JetStream batch (default: 256)
  --dry-run                 Preview actions without modifying state (default)
  --apply                   Perform archive + purge operations
  -h, --help                Show this help text

Examples:
  # File-based spool
  bash scripts/ops/purge-dlq.sh --spool /srv/dlq --retention-days 30 --apply

  # JetStream stream (requires `nats` CLI v0.0.35+)
  bash scripts/ops/purge-dlq.sh --stream broker.dlq --nats-url nats://nats:4222 --apply

The script always performs a dry-run first unless `--apply` is specified.
EOF
}

SPOOL="$DEFAULT_SPOOL"
RETENTION_DAYS="$DEFAULT_RETENTION_DAYS"
ARCHIVE_DIR="$DEFAULT_ARCHIVE_DIR"
STREAM_MODE=0
STREAM_NAME="$DEFAULT_STREAM"
NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}"
BATCH_SIZE=256
DRY_RUN=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --spool)
      SPOOL="$2"
      shift 2
      ;;
    --stream)
      STREAM_NAME="$2"
      STREAM_MODE=1
      shift 2
      ;;
    --nats-url)
      NATS_URL="$2"
      shift 2
      ;;
    -d|--retention-days)
      RETENTION_DAYS="$2"
      shift 2
      ;;
    -a|--archive-dir)
      ARCHIVE_DIR="$2"
      shift 2
      ;;
    --batch-size)
      BATCH_SIZE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --apply)
      DRY_RUN=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || [[ "$RETENTION_DAYS" -lt 1 ]]; then
  echo "Retention days must be a positive integer (got '$RETENTION_DAYS')" >&2
  exit 1
fi

cutoff_epoch="$(date -u -d "-${RETENTION_DAYS} days" +%s)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_dir_resolved="$ARCHIVE_DIR"
archive_path="$archive_dir_resolved/dlq-${timestamp}.tar.gz"

if [[ "$STREAM_MODE" -eq 1 ]]; then
  if ! command -v nats >/dev/null 2>&1; then
    echo "The 'nats' CLI is required for JetStream purge mode. Install it from https://github.com/nats-io/natscli" >&2
    exit 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "'jq' is required to parse JetStream responses." >&2
    exit 1
  fi

  echo "Inspecting JetStream stream '$STREAM_NAME' (NATS URL: $NATS_URL) for messages older than ${RETENTION_DAYS} days..."

  start_seq=0
  last_purge_seq=0
  tmp_export="$(mktemp)"
  payload_dir="$(mktemp -d)"
  trap_payload_dir() {
    rm -rf "$payload_dir"
  }
  cleanup() {
    rm -f "$tmp_export"
    trap_payload_dir
  }
  trap cleanup EXIT

  while :; do
    data="$(nats --server "$NATS_URL" --json stream view "$STREAM_NAME" --seq "$((start_seq + 1))" --count "$BATCH_SIZE" 2>/dev/null || true)"
    if [[ -z "$data" ]]; then
      break
    fi
    messages="$(echo "$data" | jq '.messages // []')"
    count="$(echo "$messages" | jq 'length')"
    if [[ "$count" -eq 0 ]]; then
      break
    fi

    purge_batch=0
    for i in $(seq 0 $((count - 1))); do
      msg="$(echo "$messages" | jq ".[$i]")"
      seq="$(echo "$msg" | jq -r '.seq')"
      ts="$(echo "$msg" | jq -r '.time')"
      body="$(echo "$msg" | jq -r '.data')"
      ts_epoch="$(date -d "$ts" +%s)"
      if [[ "$ts_epoch" -le "$cutoff_epoch" ]]; then
        purge_batch=1
        last_purge_seq="$seq"
        if [[ "$DRY_RUN" -eq 1 ]]; then
          echo "Would purge message seq=$seq ts=$ts"
        else
          echo "$body" >> "$tmp_export"
        fi
      fi
      start_seq="$seq"
    done

    if [[ "$purge_batch" -eq 0 ]]; then
      # Remaining messages are newer; stop scanning.
      break
    fi

    if [[ "$DRY_RUN" -eq 0 ]]; then
      :
    fi
  done

  if [[ "$last_purge_seq" -eq 0 ]]; then
    echo "No JetStream messages older than ${RETENTION_DAYS} days were found."
    exit 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Dry-run complete. To purge up to sequence $last_purge_seq rerun with --apply."
    exit 0
  fi

  mkdir -p "$archive_dir_resolved"
  echo "Archiving purged messages to $archive_path..."
  if [[ -s "$tmp_export" ]]; then
    tmp_tar_list="$(mktemp)"
    while IFS= read -r line; do
      hash="$(echo -n "$line" | sha256sum | awk '{print $1}')"
      filename="${hash}.json"
      file_path="$payload_dir/$filename"
      echo "$line" > "$file_path"
      echo "$filename" >> "$tmp_tar_list"
    done < "$tmp_export"
    tar -czf "$archive_path" -C "$payload_dir" -T "$tmp_tar_list"
    rm -f "$tmp_tar_list"
  else
    echo "No payloads captured for archiving; archive will not be created."
  fi

  echo "Purging JetStream stream up to sequence $last_purge_seq..."
  nats --server "$NATS_URL" stream purge "$STREAM_NAME" --seq "$last_purge_seq" >/dev/null

  echo "Completed JetStream DLQ purge. Archive path: $archive_path"
else
  if [[ ! -d "$SPOOL" ]]; then
    echo "DLQ spool directory '$SPOOL' does not exist." >&2
    exit 1
  fi
  mapfile -t files < <(find "$SPOOL" -type f -mtime +"$((RETENTION_DAYS - 1))" -print | sort)

  if [[ ${#files[@]} -eq 0 ]]; then
    echo "No DLQ artefacts older than ${RETENTION_DAYS} days under $SPOOL."
    exit 0
  fi

  echo "Found ${#files[@]} DLQ artefacts older than ${RETENTION_DAYS} days under $SPOOL:"
  for file in "${files[@]}"; do
    echo "  - $file"
  done

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Dry-run mode: no files will be archived or removed."
    exit 0
  fi

  mkdir -p "$archive_dir_resolved"
  echo "Archiving DLQ artefacts to $archive_path..."
  rel_paths=()
  for file in "${files[@]}"; do
    if [[ "$file" == "$SPOOL"/* ]]; then
      rel_paths+=("${file#$SPOOL/}")
    else
      rel_paths+=("$(basename "$file")")
    fi
  done
  tar -czf "$archive_path" -C "$SPOOL" "${rel_paths[@]}"

  echo "Removing original DLQ artefacts..."
  for file in "${files[@]}"; do
    rm -f "$file"
  done

  echo "Completed DLQ purge. Archive stored at: $archive_path"
fi
