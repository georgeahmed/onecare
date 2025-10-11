#!/usr/bin/env bash
set -euo pipefail

ENGINEER=""
TASK_SUBSTR=""
DO_SCHEMAS=0
DO_PY=0
DO_RUNTIME=0
DO_SMOKE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --engineer) ENGINEER="$2"; shift 2;;
    --task) TASK_SUBSTR="$2"; shift 2;;
    --schemas) DO_SCHEMAS=1; shift;;
    --py) DO_PY=1; shift;;
    --runtime) DO_RUNTIME=1; shift;;
    --smoke) DO_SMOKE=1; shift;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

if [[ -z "$ENGINEER" || -z "$TASK_SUBSTR" ]]; then
  echo "Usage: engineer_loop.sh --engineer <team/path> --task '<substring>' [--schemas] [--py] [--runtime] [--smoke]" >&2
  exit 1
fi

echo "[loop] Starting engineer loop for $ENGINEER, task: $TASK_SUBSTR"

if [[ $DO_SCHEMAS -eq 1 ]]; then
  echo "[loop] Running codegen (TS + optional Py via RUN_PY=1 env)"
  npm run codegen
fi

echo "[loop] TypeScript build/typecheck/lint/test"
npm run build
npm run typecheck
npm run lint
npm run test

if [[ $DO_PY -eq 1 ]]; then
  echo "[loop] Python tests"
  make -s py-test || true
fi

if [[ $DO_RUNTIME -eq 1 ]]; then
  echo "[loop] Bringing up stack (docker-compose)"
  docker-compose up -d --build
  echo "[loop] Waiting for orchestrator /health"
  until curl -sf http://localhost:3001/health >/dev/null; do sleep 0.5; done
  if [[ $DO_SMOKE -eq 1 ]]; then
    echo "[loop] Smoke: POST /safety-check"
    curl -s -X POST http://localhost:3001/safety-check \
      -H 'content-type: application/json' \
      -d '{"practiceId":"p1","patient":{"id":"abc"},"narrative":"mild headache","channel":"web"}' || true
  fi
fi

echo "[loop] Marking task done and updating status"
node scripts/team/update_task.js --engineer "$ENGINEER" --action done --task "$TASK_SUBSTR"
node scripts/team/status.js engineer "$ENGINEER" --write >/dev/null
make -s team-status-write >/dev/null 2>&1 || true

echo "[loop] Completed engineer loop for $ENGINEER"
