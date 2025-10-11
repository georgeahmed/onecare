AGENTS.md — apps/ (TypeScript Services)

Scope
- Applies to all services under `apps/`.

Service Layout
- `src/application/` — state classes and machines (business transitions only)
- `src/adapters/` — I/O boundaries: http, events, persistence, external services
- `src/index.ts` — minimal bootstrap (health endpoints, router wiring)

Practices
- Contracts: import types from `@onecare/events` rather than redefining.
- Validation: validate request bodies at HTTP edges; reject early with clear errors.
- Resilience: add timeouts, retries (bounded), and circuit breakers to outbound calls. Prefer idempotency on ingress.
- Logging: structured JSON logs; include `correlationId` when present.
- Config: read via env vars (documented in README) or `@onecare/config` when available.
- No CPU-heavy work: delegate ML/ASR/NLP to Python services.
- Correlation: accept/send `x-correlation-id` header and propagate into event envelopes.
- Errors: use a consistent error envelope (see `docs/ERRORS.md`).

When Adding Endpoints
- Add to the service README with example requests/responses and env vars.
- Keep handlers small; push business flow into state classes.
- Ensure new endpoints have minimal unit tests and, where useful, contract validation.
