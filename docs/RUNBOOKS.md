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
- Scope: NATS JetStream data (`nats-data` volume), repo `config/` files, and backup automation for dev/staging.
- Scripts: `scripts/ops/backup.sh`, `scripts/ops/restore.sh`, and `scripts/ops/verify-restore.sh` (offline drill).

Automation
- GitHub workflow `.github/workflows/backup-nightly.yml` runs every 6 hours and on demand. It captures a backup, performs an offline restore validation, and uploads artefacts for 14 days.
- Manifest (`manifest.json`) records artifact hashes, volume name, duration, and optional tag. History is appended to `nightly-backups/history.jsonl` for audit.
- Configure long-term storage (S3/Vault) by syncing the uploaded archive via the deployment pipeline or scheduled job in the hosting environment.
- Analytics retention: install the cron entries from `infra/automation/analytics-retention.cron` on the analytics hosts. Each line scopes `ANALYTICS_TIER_ROOT` to the cold bucket (`s3://onecare-analytics-cold-<env>`) and runs `npm run analytics:retention -- --vacuum` nightly at 03:00 UTC. Update the paths if the hot/warm volumes mount under a different prefix.

Backup Procedure
- Ensure JetStream is healthy (`docker compose ps` shows nats healthy).
- Run `bash scripts/ops/backup.sh` (defaults to `./backups/<timestamp>`). Override destination with `bash scripts/ops/backup.sh --output /secure/path --tag manual`.
- Outputs: `nats-jetstream.tar.gz`, `config.tar.gz`, `manifest.json`, and checksum data embedded in the manifest.
- Upload archives to encrypted storage with lifecycle policies (≥14 days). Delete local copies after verifying the upload.

Restore Procedure
- Downtime: full restore RTO target **≤60 minutes** (includes validation and service restarts).
- Stop services: `docker compose down` (restore aborts if NATS is running).
- Run `bash scripts/ops/restore.sh <backup-folder>` to hydrate the JetStream volume and `config/`. Use `--dry-run` for validation without applying.
- Restart services: `docker compose up -d`; confirm readiness via `/ready` endpoints and targeted smoke tests.
- To validate archives without impacting the live volume, run `bash scripts/ops/verify-restore.sh <backup-folder>` (restores into a temporary volume and scratch config directory).

Disaster Recovery Targets

| Scenario | RPO | RTO | Notes |
|----------|-----|-----|-------|
| JetStream data loss (single node) | 4 hours (nightly workflow) | 60 minutes | Restore JetStream and requeue DLQ backlog if required. |
| Config repository corruption | 4 hours | 30 minutes | Redeploy from latest backup or git; verify checksums. |
| Regional outage | 12 hours | 4 hours | Promote warm standby using latest off-region backup; reconfigure DNS/ingress. |

Restore Drills
- Monthly: run `.github/workflows/backup-nightly.yml` via `workflow_dispatch` and ensure verification succeeds.
- Quarterly: execute `scripts/ops/verify-restore.sh` on the latest off-site backup, then perform a full restore in staging and record timings in the DR log.
- Track drill outcomes (duration, issues, follow-up actions) in the SRE status report.

Validation Checklist
- After backup: `tar tzf <backup-dir>/nats-jetstream.tar.gz | head` to confirm non-empty archive.
- After restore: `docker exec -it $(docker compose ps -q nats) nats stream report` or run service smoke tests (booking search/create, triage safety check).
- Ensure backup log (`history.jsonl`) is appended and off-site copies are updated; keep the two most recent verified backups.
