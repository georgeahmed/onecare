ONECARE State-Class Monorepo Skeleton

This repository provides a clean, scalable project structure for implementing the ONECARE clinical operating system using a state-class pattern. It maps directly to the architecture and flows described in `Algorithm.md`.

Highlights
- TypeScript monorepo (workspaces) for event-driven services and adapters.
- Python microservices for ML-heavy components (safety gate, scribe).
- Minimal state-class stubs aligned to `Algorithm.md` sequences.
- Shared `statekit` helper for consistent state machine patterns across services.
- Shared JSON Schemas with pre-generated TS and Python models; codegen stub included.
- Infra/docs folders to keep topics, conventions, and architecture references organized.

Top-Level Layout
- `apps/`       TypeScript services (orchestrator, triage, booking, etc.)
- `packages/`   TS shared libraries (statekit, domain, events, config, ...)
- Additional shared packages: `@onecare/ports` (adapter interfaces), `@onecare/bus` (message bus)
- `services-py/` Python ML services (safety gate, scribe) + shared Pydantic models
- `schemas/`    JSON Schemas (source of truth for event contracts)
- `scripts/`    Codegen stubs and utilities
- `infra/`      Infrastructure docs (event bus topics, persistence notes)
- `docs/`       Dev docs and conventions
- `config/`     Deployment/runtime config (already present)

Next Steps
- Install deps and build TS workspaces: npm i && npm run build
- Run Python services (install via your preferred tool): uvicorn safety_gate_service.main:app --reload
- Replace pre-generated models using real codegen (see `scripts/codegen/README.md`).
- Flesh out state transitions and wire adapters (events/http/persistence).

Development
- TypeScript
  - Typecheck: npm run typecheck
  - Lint: npm run lint
  - Test: npm run test
- Python
  - Tests: in `services-py`, install dev deps (see `pyproject.toml`) and run `pytest`
- Docker
  - Local stack: docker-compose up --build
  - Try Safety Gate via orchestrator:
    curl -s -X POST http://localhost:3001/safety-check \
      -H 'content-type: application/json' \
      -d '{"practiceId":"p1","patient":{"id":"abc"},"narrative":"mild headache","channel":"web"}'

Quick Demo
- Make (Docker): make demo-docker
- Make (Local): make demo-local (requires uvicorn/fastapi installed)
- Justfile: just demo-docker or just demo-local

Full usage documentation: docs/USAGE.md
Task index: docs/TASK_INDEX.md

Operator Runbooks
- Runbooks index: docs/RUNBOOKS.md
- TLS & Credentials: infra/runbooks/tls-credentials.md
- Event Bus Subjects & ACLs: infra/event-bus/subjects-acls.md
- DLQ Operations: infra/event-bus/dlq-runbook.md
- Idempotency Store: infra/runbooks/idempotency-store.md
- OpenTelemetry Collector: infra/runbooks/otel-collector.md
