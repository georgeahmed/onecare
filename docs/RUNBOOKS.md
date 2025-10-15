Runbooks Index

Purpose
- Central index to operator runbooks and environment readiness guides.

Runbooks
- TLS & Credentials
  - infra/runbooks/tls-credentials.md — Provisioning, mounting, rotation, strict TLS.
- Event Bus
  - infra/event-bus/subjects-acls.md — Subjects/streams creation, ACLs, retention, partitioning.
  - infra/event-bus/dlq-runbook.md — DLQ inspection, triage, replay, alert thresholds.
  - docs/runbooks/nats-bus-resilience.md — Node bus reconnect, retry, and idempotency controls.
- Idempotency
  - infra/runbooks/idempotency-store.md — Redis reserve semantics, TTLs, non-PHI keys, tests.
- Observability
  - infra/runbooks/otel-collector.md — OTEL collector config for dev (stdout/OTLP), ports, env vars.
- Backups
  - docs/RUNBOOKS.md#backup--restore-jetstream--config — Snapshot/restore JetStream volume and config/.

Related Conventions
- docs/CONVENTIONS.md — Service Platform Checklist Template (copy into engineer files).

How to Use
- Before enabling a service in an environment, verify prerequisites per service Platform Checklist and consult relevant runbooks here.

Backup & Restore (JetStream + Config)
- Scope: local/dev baseline for NATS JetStream data (`nats-data` volume) and repo `config/` files.
- Scripts: `scripts/ops/backup.sh [output-dir]` and `scripts/ops/restore.sh <backup-dir>`.

Backup Procedure
- Ensure JetStream is healthy (`docker compose ps` shows nats healthy).
- Run `bash scripts/ops/backup.sh` (defaults to `./backups/<timestamp>`). Override destination with `bash scripts/ops/backup.sh /secure/path`.
- Output: `nats-jetstream.tar.gz`, `config.tar.gz`, and `manifest.json`.
- Store the folder in encrypted storage (e.g., S3 bucket with SSE, Vault file store). Delete local copies when uploaded.

Restore Procedure
- Downtime: expect ~2–5 minutes (stack stopped while restoring). Run during maintenance window.
- Stop services: `docker compose down` (required; restore script aborts if containers still running).
- Run `bash scripts/ops/restore.sh <backup-folder>` to hydrate the JetStream volume and `config/`.
- Restart services: `docker compose up -d`. Check `docker compose logs nats` and `curl http://localhost:3001/ready`.
- If restoring into a clean environment, rehydrate dependent stores (Redis, databases) before resuming traffic.

Validation
- After backup: list archives with `tar tzf backups/<timestamp>/nats-jetstream.tar.gz | head` to confirm content.
- After restore: `docker exec -it $(docker compose ps -q nats) nats stream report` (requires nats CLI) or simulate a workflow to confirm messages persist.
- Keep the latest two backups; prune older sets after confirming integrity.
