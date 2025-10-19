# QA Hermetic Test Environment

The QA `test` compose profile spins up mock dependencies and a minimal message bus so contract, E2E, and chaos drills can run deterministically without hitting shared infrastructure. This document covers the available services, how to seed fixtures, and the environment variables required by the harness.

## Services & Ports
| Service | Compose Name | Port | Purpose |
| --- | --- | --- | --- |
| NATS JetStream | `nats` | `4222` (tls) / `8222` (metrics) | Message bus used by orchestrator and replay tests. |
| Safety Gate mock | `mock-safety-gate` | `5011` | Deterministic responses for `/analyze`. Reads fixtures from `qa/env/mock-data/safety-decisions.json`. |
| Scribe mock | `mock-scribe` | `5012` | Returns seeded transcripts and drafts for `/transcribe` and `/draft`. |
| FHIR mock | `mock-fhir` | `9500` | Accepts FHIR bundles at `/fhir` and serves stored resources. |
| Anchor container | `qa-test-env` | — | Keeps the profile alive and wires health dependencies together. |

> Observability components (Grafana, Loki, Prometheus, etc.) are not included in the `test` profile. Start them explicitly with `docker compose up grafana ...` if needed.

## Bootstrapping the Stack
1. Build workspace artifacts (`npm run build` if not already generated).
2. Start the profile:
   ```bash
   docker compose --profile test up qa-test-env
   ```
   This also brings up `nats`, `mock-safety-gate`, `mock-scribe`, and `mock-fhir` via service dependencies. The compose stack is hermetic—no network calls leave the container network.
3. Seed deterministic fixtures:
   ```bash
   ./qa/env/seed.sh
   ```
   The seeding script copies anonymized fixtures from `qa/fixtures/seeds/*.json` into `qa/env/mock-data/` and posts them to each mock service’s `__seed` endpoint. Re-run after modifying fixtures.

Health probes:

```bash
curl -s http://127.0.0.1:5011/health | jq
curl -s http://127.0.0.1:5012/health | jq
curl -s http://127.0.0.1:9500/health | jq
```

Each command should report `status: "ok"` with the number of seeded objects.

## Required Environment Variables
Export these before running QA suites:

```bash
export NODE_ENV=test
export BUS_IMPL=nats
export NATS_URL=tls://onecare:onecare-secret@127.0.0.1:4222
export NATS_USER=onecare
export NATS_PASS=onecare-secret
export PY_SAFETY_GATE_URL=http://127.0.0.1:5011
export PY_SCRIBE_URL=http://127.0.0.1:5012
# Do not set FHIR_BASE_URL; orchestrator resolves http://localhost:9500/fhir in test mode.
```

TLS for NATS uses the developer certificates in `infra/tls/dev`. When running tests outside Docker, point the `NATS_TLS_*` variables to those files as needed.

## Test Execution
- Contract tests:
  ```bash
  NODE_ENV=test npm exec vitest run qa/contracts
  ```
- E2E & chaos suites:
  ```bash
  NODE_ENV=test npm run test:e2e
  ```
- Accessibility scans (axe) and DLQ/chaos drills automatically save artifacts under `artifacts/qa/`.

In CI the `build-and-test` workflow enables this profile by setting `COMPOSE_PROFILES=test` before invoking `./qa/env/seed.sh` and Vitest suites. See `.github/workflows/ci.yml` for the orchestration steps added alongside QA-01.15.

## Troubleshooting
- **Mocks not seeded:** verify `./qa/env/seed.sh` succeeded and the containers expose ports `5011/5012/9500` on localhost.
- **TLS errors when connecting to NATS:** import the dev CA certificate (`infra/tls/dev/ca.crt`) into the client trust store or run `BUS_IMPL=memory` for purely in-memory tests.
- **Port conflicts:** stop local services occupying 5011/5012/9500 or override via `SAFETY_URL`, `SCRIBE_URL`, `FHIR_URL` environment variables before running `seed.sh`.
- **Fixture edits:** update files under `qa/fixtures/seeds/`, rerun `./qa/env/seed.sh`, and commit the generated `qa/env/mock-data/*` snapshots.
