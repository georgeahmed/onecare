Orchestrator Service

Purpose
- Authenticate, authorize, normalize to FHIR, transact, enrich, route, and audit every ingress event.

State Flow (high level)
- Received → Authorized → ConsentChecked → IdempotencyReserved → SafetyEvaluated → Normalized → Validated → Persisted → Routed → Audited

Folders
- `src/application/` state classes and machine
- `src/adapters/` http/events/persistence integrations

FHIR Validation
- The orchestrator now validates every normalized transaction bundle against `schemas/fhir/bundle-transaction.json` (and the referenced entry schemas) before writing to the repository. Payloads that drift from the contract return HTTP 400 with code `invalid_fhir`; update the schema and rerun codegen before changing bundle shapes.

Performance Baselines
- HTTP adapters use keep-alive connection pools for FHIR and Object Store calls. `fhir.transaction.duration_ms` and `object.store.put.duration_ms` histograms summarise the end-to-end request cost alongside the existing per-request metrics.
- Run `node scripts/perf/fhir_client_bench.js` (pure serialization microbench) to sanity-check local budgets. Current sample (10k iterations, 256 KB payloads) yields:
  - `fhir.transaction.duration_ms` avg ≈0.002 ms (p95 ≈0.002 ms, p99 ≈0.003 ms)
  - `object.store.put.duration_ms` avg ≈0.014 ms (p95 ≈0.022 ms, p99 ≈0.046 ms)
- Re-run after touching bundle composition or Object Store staging helpers to keep the baselines fresh.

Dev Endpoint (example)
- POST `/safety-check` → forwards a `PortalSubmission` to Python Safety Gate and returns `SafetyDecision`.
  - Body example:
    {
      "practiceId": "p1",
      "patient": {"id": "abc"},
      "narrative": "I have chest pain",
      "channel": "web"
    }
  - On `SAFE_TO_CONTINUE`, publishes `triage.input` event via in-memory bus with `EventEnvelope`.

Zero-Trust Gate
- Requests must include `Authorization` (`Bearer <token>`), `X-Actor-Type` (`patient|practitioner|system`), `X-Actor-Id`, and `X-Request-Id`; optional `X-Auth-Scope` conveys granted scopes.
- The orchestrator runs `verifySignatureAndReplayGuard`, `authorize(actor,'submit',patientId,scope)`, and `checkConsent(patientId,'care',['QuestionnaireResponse','Communication'])` before touching downstream systems.
- Any denial returns HTTP 403 with the standard error envelope and emits an `audit.event` containing the correlation ID, actor, and reason.
- Replay guard deduplicates `requestId`+`Authorization` combinations for `SECURITY_REPLAY_WINDOW_MS` (default 300,000 ms / 5 minutes).

Configuration
- Core service:
  - `PRACTICE_ID` (defaults to `demo`), `NODE_ENV`, and the YAML config under `config/nhs_gp_defaults.yaml` drive consent rules and guardrail defaults (`timeout_ms` is clamped 400–2000 ms, fallback defaults to `rules`).
  - Effective config is logged once at startup without PHI; safety gate timeout feeds the guardrail around the Python service.
- Bus implementation:
  - `BUS_IMPL` controls which adapter loads (`memory` in dev, `nats` in prod). When `nats` is selected, set `NATS_URL` (comma-separated URLs), `NATS_QUEUE_GROUP` (defaults to `onecare-workers`), and `NATS_PARTITIONS` to tune shard count for ordering guarantees.
  - Guarded publishes honour `ORCHESTRATOR_BUS_PUBLISH_TIMEOUT_MS`, `ORCHESTRATOR_BUS_PUBLISH_MAX_RETRIES`, and `ORCHESTRATOR_BUS_PUBLISH_BACKOFF_MS`; idempotent consumers are expected to use the envelope id + `IdempotencyStore`.
  - Multi-tenant quotas: configure per-tenant throughput with `NATS_TENANT_RATE_TPS`, `NATS_TENANT_RATE_BURST`, and optional overrides (`NATS_TENANT_RATE_OVERRIDES` accepts JSON or `tenant=rate:burst` pairs). When exhausted, publishes fail fast with `tenant_quota_exceeded` and increment `bus.quota.block`.
  - Size & compression: default message cap mirrors `NATS_MAX_MESSAGE_BYTES` (512KB). Payloads above `NATS_COMPRESSION_THRESHOLD_BYTES` are gzip-compressed automatically; monitor `bus.msg.compressed` / `bus.msg.too_large`. Hot partition metrics use `NATS_PARTITION_HOT_KEY_WINDOW_MS` & `NATS_PARTITION_HOT_KEY_RATE_TPS` to raise alerts when keys dominate a subject.
- Security & credentials:
  - TLS: enable with `NATS_TLS_ENABLED=1` and point to PEM bundles via `NATS_TLS_CA_PATH`, `NATS_TLS_CERT_PATH`, and `NATS_TLS_KEY_PATH`. Prod enforces TLS by also setting `NATS_TLS_REQUIRED=1`.
  - Credentials: provide a scoped JetStream creds file at `NATS_CREDS_PATH`; rotate by updating the secret and restarting the deployment (readiness gating ensures a clean reconnect).
  - Additional hardening: `NATS_TLS_REJECT_UNAUTHORIZED=0/1` for custom CA behaviour, `NATS_IDLE_HEARTBEAT_MS` and `NATS_FLOW_CONTROL` manage long-lived subscriptions.
- Local broker & tooling:
  - Run `docker compose up nats` to start the dev broker exposed on `nats://localhost:4222`. Point the orchestrator at it with `BUS_IMPL=nats NATS_URL=nats://localhost:4222`.
  - Inspect JetStream state using the official CLI (e.g., `nats --creds var/secrets/orchestrator.creds stream info orchestrator`).
  - Replay DLQ entries after triage with `node scripts/dlq-requeue.js --source broker.dlq --match correlationId=<cid> --dry-run`.
- Booking upstreams:
  - `BOOKING_AVAILABILITY_URL` and `BOOKING_SERVICE_URL` must be HTTP(S) endpoints without embedded credentials; link-local/metadata hosts are blocked. Loopback hosts are only permitted when `NODE_ENV` is not `production` or when `ORCHESTRATOR_ALLOW_LOOPBACK_UPSTREAMS=1` is explicitly set for local overrides.
- Bus readiness honours `BUS_READY_PENDING_LAG` (defaults to `200`) and mirrors `@onecare/bus` diagnostics; alerts fire when lag or `bus.nats.backpressure.events` climbs.

Resilience & Backpressure
- Concurrency is governed by `ORCHESTRATOR_MAX_CONCURRENCY_GLOBAL` (default `64`), `ORCHESTRATOR_MAX_CONCURRENCY_DEFAULT` (per-route fallback), and per-route overrides such as `ORCHESTRATOR_MAX_CONCURRENCY_SAFETY`, `ORCHESTRATOR_MAX_CONCURRENCY_BOOKING`, and `ORCHESTRATOR_MAX_CONCURRENCY_FEATURE_LOG`. When limits are exceeded the service returns HTTP 503 with code `busy` and records `backpressure.reject`.
- Token-bucket rate limits are enforced per actor (`ORCHESTRATOR_RATE_LIMIT_DEFAULT_PER_MINUTE`, `ORCHESTRATOR_RATE_LIMIT_SAFETY_PER_MINUTE`) with optional window/penalty overrides (`ORCHESTRATOR_RATE_LIMIT_WINDOW_MS`, `ORCHESTRATOR_RATE_LIMIT_BLOCK_MS`, `ORCHESTRATOR_RATE_LIMIT_SAFETY_WINDOW_MS`, `ORCHESTRATOR_RATE_LIMIT_SAFETY_BLOCK_MS`). Exhausted callers receive HTTP 429 and `Retry-After`.
- Graceful shutdown is coordinated via POSIX signals; `/ready` reports `draining: true` and new ingress requests are refused with `busy` while existing work is drained.

Event Publishing & DLQ
- `ORCHESTRATOR_BUS_PUBLISH_TIMEOUT_MS`, `ORCHESTRATOR_BUS_PUBLISH_MAX_RETRIES`, and `ORCHESTRATOR_BUS_PUBLISH_BACKOFF_MS` control guarded bus publishes. Failures are retried with exponential back-off and, after exhaustion, routed to `broker.dlq` with a minimal payload reference (`patientRef` hashed) and metadata for replay.
- `audit.event` writes are buffered with bounded queue + retry; use `flushAuditLedgerForTest()` in unit tests to await the buffer.

Privacy
- Patient identifiers are never logged directly; audits and structured logs surface `patientRef` (SHA-256 hash) while payloads continue to carry full identifiers for downstream systems. DLQ metadata only includes hashed references and request identifiers.

Logging
- Use `logger.info|warn|error` from `@onecare/observability`; it emits structured JSON with automatic `correlationId`. See `docs/observability/LOGGING_POLICY.md` for required fields and redaction rules.

Tracing
- Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) to point at an OTLP HTTP collector such as the dev `otel-collector` (`http://localhost:4318`).
- Optionally set `OTEL_EXPORTER_OTLP_HEADERS` for collector auth (e.g., `x-otlp-api-key=dev-key`).
- Use `OTEL_ENABLED=1` to force-enable spans even without an explicit endpoint; otherwise enabling the exporter endpoint automatically turns tracing on.
