ONECARE Usage Guide

This guide documents all common commands and workflows to build, run, test, and operate the monorepo locally.

Prerequisites
- Node.js: v20+ (recommended)
- npm: v9+
- Python: 3.11+ (for ML services)
- Docker + Docker Compose (for full local stack)
- Optional: make or just for task shortcuts

Environment Variables
- NODE_ENV — environment name (default: development)
- PORT_ORCHESTRATOR / PORT — port for orchestrator (default: 3001)
- PY_SAFETY_GATE_URL — Safety Gate base URL (default: http://localhost:8081)
- PY_SCRIBE_URL — Scribe base URL (default: http://localhost:8082)
- LOG_LEVEL — logging level (default: info)
- BUS_IMPL — message bus implementation (`memory` for local dev, `nats` in docker)
- NATS_URL — NATS connection URL(s) (comma-separated, e.g. nats://onecare:onecare-secret@nats:4222)
- NATS_USER / NATS_PASS — credentials for protected NATS servers
- NATS_CONNECT_TIMEOUT_MS — connect timeout (default: 2000ms)
- NATS_MAX_RECONNECT_ATTEMPTS — reconnect attempts before marking not ready (default: 10)
- NATS_RECONNECT_DELAY_MS — delay before retrying manual reconnects (default: 1500ms)

Example: copy .env.example to .env and adjust as needed.

Install & Build
- Install deps: npm ci
- Build all workspaces: npm run build
- Typecheck: npm run typecheck

Lint, Format, Test
- Lint (TS): npm run lint
- Format (Prettier): npm run format
- Test (TS via Vitest): npm run test
- Test (Python via Pytest): ./services-py/run-tests.sh

Codegen (Contracts)
- TS contracts from JSON Schemas: npm run codegen
- Dry check (no generation): npm run codegen:check
- TS + Python generation (requires datamodel-code-generator): RUN_PY=1 npm run codegen

Generators
- TypeScript: json-schema-to-typescript (json2ts)
- Python: datamodel-code-generator (generates Pydantic models)

Makefile Shortcuts
- make install — npm ci
- make build — build all workspaces
- make typecheck — TS project references typecheck
- make lint / make format / make test
- make codegen / make codegen-check
- make check-task-cards — verify required sections in team/*/tasks/*.md
- make py-test — run Python tests
- make py-safety — start Safety Gate locally on 8081
- make py-scribe — start Scribe locally on 8082
- make dev-run — start Safety Gate + Orchestrator (keeps running)
- make dev-stop — stop Safety Gate + Orchestrator started by dev-run
- make docker-up / make docker-down — compose lifecycle
- make demo-docker — end-to-end demo via Docker (safety-check)
- make demo-local — local demo (uvicorn + orchestrator)
- make perf-orchestrator — perf harness for /safety-check (requires orchestrator)
 - make agent-closeout — codegen → typecheck → test → update team status

Justfile Shortcuts (if using just)
- just install / just build / just typecheck / just lint / just format / just test
- just codegen / just codegen-check
- just py-test / just py-safety / just py-scribe
- just docker-up / just docker-down
- just demo-docker / just demo-local

Run Locally (Without Docker)
1) Start Safety Gate (Python)
   - uvicorn services-py/safety_gate_service/main:app --reload --port 8081
2) Build Orchestrator (TS)
   - npm -w @onecare/app-orchestrator run build
3) Start Orchestrator
   - PORT=3001 PY_SAFETY_GATE_URL=http://localhost:8081 node apps/orchestrator/dist/index.js
4) Optional: quick perf
   - make perf-orchestrator

Health checks
- Orchestrator: curl http://localhost:3001/health
- Orchestrator readiness: curl http://localhost:3001/ready (503 when bus disconnected)
- Safety Gate docs: curl http://localhost:8081/docs

Run with Docker Compose
- Start: docker-compose up --build
- Stop: docker-compose down -v
- Services: orchestrator waits for NATS to become healthy; readiness at /ready only turns green after the bus connects
- Resource guardrails: compose applies `restart: unless-stopped` and limits containers to ~0.5–0.75 CPU / 512–768 MiB RAM (see `docker-compose.yml`). Use `docker compose --compatibility up` if your CLI ignores `deploy.resources`.
- NATS ulimits: `nofile` raised to 65536 to avoid JetStream issues under fan-out load.
- Adjust resources by editing `deploy.resources` (for CPU/memory) or overriding via `docker compose run -e`. Keep orchestrator ≥0.5 CPU/512 MiB when running tests.
- Verify limits during load by running `docker stats` and confirming containers stay within their budgets (look for throttling in the `CPUPerc` column).

Exposed ports
- Orchestrator: localhost:3001
- Safety Gate: localhost:8081
- Scribe: localhost:8082
- NATS (dev): localhost:4222 (client), 8222 (monitor)

Analytics Consumer
- Build: `npm run --workspace @onecare/app-analytics build`
- Run locally (memory bus + JSONL sink): `npm run --workspace @onecare/app-analytics start`
- Configure bus via `NATS_URL` (optional); override sink path with `ANALYTICS_SINK_PATH`.
- Docker: `docker compose up analytics` starts the worker alongside NATS and writes metrics under the `analytics-metrics` volume.
- Daily rollups: `npm run metrics:rollup` aggregates counts/p95 per metric into `var/analytics/rollup.jsonl`. Use `--input`, `--output`, or `--date YYYY-MM-DD` to override defaults.
- Scheduling: integrate the rollup command into your cron/CI scheduler once the cadence is defined (for example `0 1 * * * npm run metrics:rollup -- --date $(date -I) --output /var/analytics/rollup.$(date -I).jsonl`).
- Data hygiene: `npm run metrics:quality` produces a markdown report flagging missing fields and numeric outliers. Adjust the z-score threshold via `--zscore` or `ANALYTICS_QUALITY_ZSCORE`.
- Feature backfill: `npm run feature:backfill -- --input <events.jsonl> --output <features.jsonl>` hydrates the feature store from historical triage events, validating payloads against `triage-core`.
- Feature compaction: `node scripts/feature_compact.js --input <features.jsonl> --retention-days 7` enforces retention and deduplicates feature records.
- Feature purge: `node scripts/feature_store_purge.js --url "$FEATURE_STORE_URL" --retention-days 30` deletes feature rows older than the retention window. The `feature-store-purge` GitHub Action runs this nightly for `dev`, `staging`, and `prod` when the respective `FEATURE_STORE_URL_*` secrets are configured.

Team & Status
- Team status: make team-status
- Update progress from checkboxes: make team-status-write
- Export status JSON: make team-status-json
- Generate GitHub issues from engineer tasks: make team-issues
- Per‑engineer loop helper: make engineer-loop ENGINEER=<path> TASK='<substring>' SCHEMAS=1 PY=1 RUNTIME=1 SMOKE=1
 - Agent close-out: make agent-closeout (after checking tasks)
- Local CI: make ci-local
- Bring up stack and smoke test: make stack-up && make stack-smoke

Operator Runbooks
- TLS & Credentials: infra/runbooks/tls-credentials.md
- Event Bus Subjects & ACLs: infra/event-bus/subjects-acls.md
- Idempotency Store (Redis): infra/runbooks/idempotency-store.md
- DLQ Operations: infra/event-bus/dlq-runbook.md

HTTP Endpoints (Dev)
- Orchestrator
  - GET /health → ok
  - GET /ready → { status: 'ready' | 'not_ready', bus: 'connected' | 'disconnected' }
  - POST /safety-check → forwards to Safety Gate /analyze
    - Request (PortalSubmission): { "practiceId": "p1", "patient": { "id": "abc" }, "narrative": "...", "channel": "web" }
    - Response (SafetyDecision): { "outcome": "SAFE_TO_CONTINUE" | "DIVERTED", "reason"?: string }
    - Required headers: `Authorization: Bearer <token>`, `X-Actor-Type`, `X-Actor-Id`, `X-Request-Id`; optional `X-Auth-Scope` (space-delimited). Correlation ID header remains optional.
    - Side-effect (dev): on SAFE_TO_CONTINUE, publishes triage.input event using EventEnvelope on in-memory bus

- Safety Gate (FastAPI)
  - POST /analyze (from PortalSubmission) → SafetyDecision

- Scribe (FastAPI)
  - POST /transcribe (ScribeAudio) → { text }
  - POST /draft (Transcript) → { summary }

Schemas and Contracts
- Master schemas: schemas/ (source of truth)
- TS contracts: packages/events/src/contracts/* (generated)
- Python models: services-py/common/contracts/models.py (generated)
- Codegen script: scripts/codegen/generate.js
  - DRY_RUN=1 to verify outputs exist and expose expected symbols
  - RUN_PY=1 to also generate Python models

Dev Bus Demo
- Build orchestrator and triage: npm -w @onecare/app-orchestrator run build && npm -w @onecare/app-triage run build
- Start triage dev worker: node apps/triage/dist/dev/worker.js (or npm -w @onecare/app-triage run dev:worker)
- POST to /safety-check with the zero-trust headers and observe triage worker log the triage.input receipt

CI (GitHub Actions)
- codegen job: generates TS + Python contracts and auto-commits changes on PRs from same repo
- ts job: typecheck, lint, test
- py job: pytest + OpenAPI validation
- contracts guard (push): fails if schemas changed without contract updates

Manual runs
- Contracts sync check: bash scripts/ci/check_contracts_sync.sh HEAD^ HEAD
- OpenAPI validation: python scripts/ci/validate_openapi.py

Adding a New Service
1) Create apps/<service> with src/application and src/adapters
2) Add package.json + tsconfig.json (composite) and reference packages
3) Update tsconfig.json (root) references
4) Document endpoints in apps/<service>/README.md and update docs/USAGE.md if commands change
5) Add tests and update CI if needed

Changing Contracts
1) Edit/add schemas under schemas/
2) Run npm run codegen (or let CI do it on PRs)
3) Update service code to use new/updated contracts
4) Update docs/USAGE.md and service READMEs if inputs/outputs change

Troubleshooting
- TypeScript build fails on references: run npm run build from repo root and ensure package tsconfig.json has composite: true and proper references
- Python import issues in CI scripts: ensure services-py is on PYTHONPATH (script handles this)
- Docker port conflicts: change exposed ports or stop conflicting services

Where to Ask / Contribute
- Open PRs using .github/pull_request_template.md
- Follow AGENTS.md guidelines (root and per-folder)
