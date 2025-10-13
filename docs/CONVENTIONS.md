Project Conventions

Folders
- apps/<service>/src/application: state classes and machines
- apps/<service>/src/adapters: I/O integrations (http, events, persistence)
- packages/statekit: shared state-machine helpers
- packages/events: topics/constants
- packages/domain: domain types
- packages/config, security, observability: stubs for common concerns

Style
- Keep state classes small and single-responsibility.
- No business logic in adapters; keep side-effects in adapters, transitions in states.
- Emit metrics/audit on transitions.

Service Platform Checklist Template
- Broker & Topics
  - Broker reachable (NATS/Kafka) with TLS/credentials; firewall/egress allowed. See: infra/runbooks/tls-credentials.md
  - Subjects/streams created for topics and DLQ; subject ACLs and retention configured. See: infra/event-bus/subjects-acls.md, infra/event-bus/dlq-runbook.md
- Contracts & Codegen
  - JSON Schemas updated first; run TS/Python codegen; compile validators (Ajv/Pydantic) at ingress and before publish; CI drift guard in place.
- Idempotency Store
  - Redis (or equivalent) provisioned; reserve semantics available; TTL configured; keys exclude PHI. See: infra/runbooks/idempotency-store.md
- Observability
  - CorrelationId propagation; structured logs (no PHI), metrics (counters/histograms), and OpenTelemetry traces configured.
- Security
  - SSRF allowlists for outbound calls; TLS verification; header/input sanitation; deny-by-default for missing consent.
  - Outbound client adapters (CPCS, GP Connect, ICS) must redact secrets from logs, propagate correlation IDs, and reuse shared guard rails (timeouts, retries, circuit breakers).
- Backpressure & Rate Limits
  - Concurrency caps (semaphore) and per-tenant token-bucket limits; 429/503 envelopes; pressure metrics.
- Health & Shutdown
  - /healthz and /readyz endpoints reflecting dependencies; graceful drain on SIGTERM.
- Privacy & Retention
  - Redaction helpers; PHI minimization in payloads; retention windows documented and enforced.
- Performance & Fault Injection
  - Perf scripts (autocannon) for p50/p95 baselines; fault-injection tests for timeouts/retries/CB/DLQ; budgets documented.

Usage
- Copy this checklist into each service’s engineer file under “Platform Checklist (pre-flight)” and tailor specifics (endpoints, creds, topics).
- Link service-specific run/runbook docs from READMEs.
