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
- Set `PRACTICE_ID` (defaults to `demo`) and the orchestrator will load `config/nhs_gp_defaults.yaml`, merge overrides, and enforce safety gate floors/ceilings (`timeout_ms` clamped to 400–2000 ms, fallback defaults to `rules`).
- Effective config is logged once at startup without PHI; safety gate timeout feeds the guardrail around the Python service.

Logging
- Use `logger.info|warn|error` from `@onecare/observability`; it emits structured JSON with automatic `correlationId`. See `docs/observability/LOGGING_POLICY.md` for required fields and redaction rules.

Tracing
- Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) to point at an OTLP HTTP collector such as the dev `otel-collector` (`http://localhost:4318`).
- Optionally set `OTEL_EXPORTER_OTLP_HEADERS` for collector auth (e.g., `x-otlp-api-key=dev-key`).
- Use `OTEL_ENABLED=1` to force-enable spans even without an explicit endpoint; otherwise enabling the exporter endpoint automatically turns tracing on.
