Title: Bus Security & Operations Playbook
Date: 2025-10-18
Status: Accepted

Context
- Moving to NATS JetStream requires a hardened deployment: mutual TLS, scoped credentials, and health monitoring aligned with clinical data SLAs.
- We must document how credentials are provisioned/rotated, how topics/subjects are access-controlled, and how operators handle DLQ overflow or replay without leaking PHI.
- Existing runbooks cover orchestrator resilience but not specific bus steps (TLS bundle refresh, JetStream backpressure, replay tooling).

Decision
- Enforce TLS for all production brokers. `NATS_TLS_ENABLED`/`NATS_TLS_REQUIRED` gate the client, and services load certificates via `NATS_TLS_CA_PATH`, `NATS_TLS_CERT_PATH`, and `NATS_TLS_KEY_PATH`. Local/dev keeps TLS optional.
- Use NATS nkey/creds files stored at `NATS_CREDS_PATH`; generate per-service accounts with limited publish/subscribe permissions (subjects `orchestrator.*`, DLQ write-only, etc.). Rotate creds quarterly or upon compromise using `nsc` and redeploy via sealed secrets.
- Require `BUS_IMPL=nats` and `NATS_URL` pointing at the JetStream cluster; queue groups (`NATS_QUEUE_GROUP`) and partition count (`NATS_PARTITIONS`) are configured per service to avoid hot spots.
- Health/readiness surfaces `pendingLag`, `inFlight`, `reconnects`, and backpressure flags. Alert when lag exceeds `BUS_READY_PENDING_LAG` or when DLQ publish failures increment beyond threshold.
- DLQ handling: messages land on `broker.dlq` with hashed identifiers (`patientRef`, `messageId`). Operators replay via `node scripts/dlq-requeue.js` (honours `NATS_URL`, TLS, creds) after sanitising payloads and confirming downstream readiness.
- Tenant quotas: enforce per-tenant token buckets on publish with `NATS_TENANT_RATE_TPS`/`NATS_TENANT_RATE_BURST` and optional JSON overrides (`NATS_TENANT_RATE_OVERRIDES`). Breaches emit `bus.quota.block` and requests fail fast (`tenant_quota_exceeded`) so operators can surface abusive tenants.
- Compression: large payloads auto-compress (`NATS_COMPRESSION_THRESHOLD_BYTES`) before publish. Compression emits `bus.msg.compressed`; if the message still exceeds `NATS_MAX_MESSAGE_BYTES`, we log `bus.msg.too_large` and fail the publish so callers can move binaries to object storage.
- Credential rotation & TLS refresh: 1) generate new creds/certs, 2) deploy to secret store, 3) restart services (graceful drain). Automated jobs publish rotation events for audit.
- Document incident actions: throttle publish rate or scale consumers when `bus.nats.backpressure.events` spikes; trigger fail-open to MemoryBus only in lower environments.

Consequences
- Secrets management must supply certs/creds on disk or tmpfs before the service boots; startup fails fast if TLS/creds are missing when required.
- Observability dashboards need to track the new metrics (`bus.nats.handler.errors`, `bus.nats.dlq.published`, `bus.nats.pending_lag`). Ops should set alerts tied to patient-impacting thresholds.
- DLQ replay is controlled and auditable. Since payloads are already redacted, operators do not access PHI during triage.
- Regular credential rotation introduces short service restarts; readiness gates ensure traffic resumes only after the fresh connection stabilises.
