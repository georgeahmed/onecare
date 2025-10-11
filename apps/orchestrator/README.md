Orchestrator Service

Purpose
- Authenticate, authorize, normalize to FHIR, transact, enrich, route, and audit every ingress event.

State Flow (high level)
- Received → Authorized → ConsentChecked → Normalized → Validated → Persisted → Enriched → Routed → Audited

Folders
- `src/application/` state classes and machine
- `src/adapters/` http/events/persistence integrations

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

Logging
- Use `logger.info|warn|error` from `@onecare/observability`; it emits structured JSON with automatic `correlationId`. See `docs/observability/LOGGING_POLICY.md` for required fields and redaction rules.

Tracing
- Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) to point at an OTLP HTTP collector such as the dev `otel-collector` (`http://localhost:4318`).
- Optionally set `OTEL_EXPORTER_OTLP_HEADERS` for collector auth (e.g., `x-otlp-api-key=dev-key`).
- Use `OTEL_ENABLED=1` to force-enable spans even without an explicit endpoint; otherwise enabling the exporter endpoint automatically turns tracing on.
