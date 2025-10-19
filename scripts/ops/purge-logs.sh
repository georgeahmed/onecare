#!/usr/bin/env bash

set -euo pipefail

DEFAULT_ROOT="${LOG_ROOT:-/var/log/onecare}"
DEFAULT_RETENTION_DAYS="${RETENTION_DAYS:-14}"
DEFAULT_ARCHIVE_DIR="${ARCHIVE_DIR:-archives/logs}"

usage() {
  cat <<'EOF'
Usage: purge-logs.sh [options]

Safely archive and delete log files older than the configured retention window.

Options:
  -r, --root PATH           Log root directory (default: $LOG_ROOT or /var/log/onecare)
  -d, --retention-days N    Retention window in days (default: 14)
  -a, --archive-dir PATH    Directory to write compressed archives (default: ./archives/logs)
  --include-glob PATTERN    Additional glob (relative to root) to include (can be repeated)
  --dry-run                 Print actions without performing them (default)
  --apply                   Execute archive + delete actions
  -h, --help                Show this help text

Examples:
  bash scripts/ops/purge-logs.sh --root /var/log/onecare --retention-days 14
  bash scripts/ops/purge-logs.sh --apply --archive-dir /secure/log-archives

The script creates a tar.gz archive containing the files scheduled for deletion.
Archives retain the directory structure relative to the log root.
EOF
}

ROOT="$DEFAULT_ROOT"
RETENTION_DAYS="$DEFAULT_RETENTION_DAYS"
ARCHIVE_DIR="$DEFAULT_ARCHIVE_DIR"
DRY_RUN=1
INCLUDE_GLOBS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--root)
      ROOT="$2"
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
    --include-glob)
      INCLUDE_GLOBS+=("$2")
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

if [[ ! -d "$ROOT" ]]; then
  echo "Log root '$ROOT' does not exist" >&2
  exit 1
fi

find_args=(-type f -mtime +"$((RETENTION_DAYS - 1))")
for glob in "${INCLUDE_GLOBS[@]}"; do
  find_args+=(-o -path "$ROOT/$glob")
done

mapfile -t files < <(find "$ROOT" -type f -mtime +"$((RETENTION_DAYS - 1))" -print | sort)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No log files older than ${RETENTION_DAYS} days under $ROOT."
  exit 0
fi

echo "Found ${#files[@]} log files older than ${RETENTION_DAYS} days under $ROOT:"
for file in "${files[@]}"; do
  echo "  - $file"
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run mode: no files will be archived or removed."
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_dir_resolved="$ARCHIVE_DIR"
mkdir -p "$archive_dir_resolved"
archive_path="$archive_dir_resolved/logs-${timestamp}.tar.gz"

tmpfile="$(mktemp)"
cleanup() {
  rm -f "$tmpfile"
}
trap cleanup EXIT

for file in "${files[@]}"; do
  if [[ "$file" == "$ROOT"/* ]]; then
    rel="${file#$ROOT/}"
  else
    rel="$(basename "$file")"
  fi
  echo "$rel" >> "$tmpfile"
done

echo "Archiving files to $archive_path..."
tar -czf "$archive_path" -C "$ROOT" -T "$tmpfile"

echo "Removing original files..."
while IFS= read -r rel; do
  rm -f "$ROOT/$rel"
done < "$tmpfile"

echo "Completed log purge."
echo "Archive stored at: $archive_path"
