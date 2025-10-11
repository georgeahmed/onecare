Runbooks Index

Purpose
- Central index to operator runbooks and environment readiness guides.

Runbooks
- TLS & Credentials
  - infra/runbooks/tls-credentials.md — Provisioning, mounting, rotation, strict TLS.
- Event Bus
  - infra/event-bus/subjects-acls.md — Subjects/streams creation, ACLs, retention, partitioning.
  - infra/event-bus/dlq-runbook.md — DLQ inspection, triage, replay, alert thresholds.
- Idempotency
  - infra/runbooks/idempotency-store.md — Redis reserve semantics, TTLs, non-PHI keys, tests.
 - Observability
   - infra/runbooks/otel-collector.md — OTEL collector config for dev (stdout/OTLP), ports, env vars.

Related Conventions
- docs/CONVENTIONS.md — Service Platform Checklist Template (copy into engineer files).

How to Use
- Before enabling a service in an environment, verify prerequisites per service Platform Checklist and consult relevant runbooks here.
