#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

NODE_ENV=test npm exec vitest -- run apps/orchestrator/test/e2e/triage-flow.test.ts "$@"
