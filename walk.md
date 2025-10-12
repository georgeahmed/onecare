# Walkthrough

What to start for local development, in what order, and why.

## 1) Install dependencies (one-time)
- Node.js 20+ and npm installed.
- From repo root: `npm ci`

## 2) Start required service (why and when)
- Safety Gate (required)
  - Why: Orchestrator `/safety-check` calls Safety Gate `/analyze`. If it isn’t running, requests fail.
  - When: Start before the orchestrator.
  - How: `make py-safety` (or `uvicorn services-py/safety_gate_service/main:app --reload --port 8081`)

## 3) Start the orchestrator
- Build: `npm -w @onecare/app-orchestrator run build`
- Run: `PORT=3001 node apps/orchestrator/dist/index.js`
  - Optional: override Safety Gate URL with `PY_SAFETY_GATE_URL=http://localhost:8081` (defaults to this).
- Verify:
  - Health: `curl -sf http://localhost:3001/health`
  - Ready: `curl -sf http://localhost:3001/ready`
  - Demo: POST to `/safety-check` (see example in `README.md`).

Example curl for /safety-check
```
curl -s -X POST http://localhost:3001/safety-check \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev-token' \
  -H 'x-actor-type: patient' \
  -H 'x-actor-id: demo-patient' \
  -H 'x-request-id: demo-req-1' \
  -H 'x-auth-scope: submit triage:submit' \
  -d '{"practiceId":"p1","patient":{"id":"abc"},"narrative":"mild headache","channel":"web"}'
```

Health/Ready quick checks
```
# Orchestrator
curl -s http://localhost:3001/health
curl -s http://localhost:3001/ready

# Safety Gate (Python)
curl -s http://localhost:8081/health
curl -s http://localhost:8081/ready
```

## Optional services (only start when needed)
- NATS (dev message broker)
  - Why: Use a real broker instead of in-memory bus (fan-out, DLQ, readiness gating).
  - When: Only if you set `NATS_URL` or run Docker Compose.
  - How: via Docker Compose (see below).

- OpenTelemetry Collector
  - Why: Collect and view traces/metrics/logs from services.
  - When: Only if you set OTEL exporter envs (e.g., `OTEL_EXPORTER_OTLP_ENDPOINT`).
  - How: via Docker Compose.

- Scribe service
  - Why: Work on `/transcribe` and `/draft` endpoints in Python scribe.
  - When: Only for scribe development; not required for `/safety-check`.
  - How: `make py-scribe` (or `uvicorn services-py/scribe_service/main:app --reload --port 8082`).

## 4) Full stack via Docker (optional)
- Start everything (orchestrator, Safety Gate, Scribe, NATS, OTEL): `docker-compose up --build`
- Use this when you want the real bus/telemetry stack. Orchestrator readiness turns green after bus connects.

Quick local run (both services)
- Start both Safety Gate and Orchestrator, then stop later:
  - Up: `make dev-run`
  - Stop: `make dev-stop`

## 5) Quick checks
- TypeScript: `npm run typecheck && npm run test`
- Python: `./services-py/run-tests.sh` (or `pytest` inside `services-py`)

## Notes
- Not required in dev: GP Connect API, external LLM APIs. The minimal flow only needs the local Safety Gate.
- The orchestrator uses an in-memory bus by default (no NATS needed) unless `NATS_URL` is set or running via Compose.

## Troubleshooting
- 500 from `/safety-check`: ensure Safety Gate is running on `http://localhost:8081`.
- `/ready` shows `not_ready` when using NATS: wait for NATS to be healthy or unset `NATS_URL` to use in-memory bus.
