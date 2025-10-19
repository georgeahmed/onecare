# Documentation Index

This index highlights the primary analytics and feature-store guides delivered as part of the DE-01/DE-02 workstream.
See `docs/TASK_INDEX.md` for the broader repository catalogue.

## Analytics Pipeline

- [`docs/ANALYTICS_BACKFILL.md`](ANALYTICS_BACKFILL.md) — Backfill CLI usage, ledger checkpoints, dry-run/resume, operational safeguards.
- [`docs/ANALYTICS_DQ.md`](ANALYTICS_DQ.md) — Runtime guardrails, quarantine workflow, threshold catalogue, and remediation cadence.
- [`docs/ANALYTICS_LINEAGE.md`](ANALYTICS_LINEAGE.md) — OpenLineage event format, job coverage, and local inspection tips.
- [`docs/ANALYTICS_PERF.md`](ANALYTICS_PERF.md) — Load generation tooling, recommended experiments, and cost/perf guidance.
- [`docs/ANALYTICS_SECURITY.md`](ANALYTICS_SECURITY.md) — Access model, IAM alignment, encryption posture, and audit expectations.

## Feature Store

- [`docs/FEATURE_README.md`](FEATURE_README.md) *(new)* — Central index for feature-store docs, quickstarts, and ownership.
- [`docs/FEATURE_DQ.md`](FEATURE_DQ.md) *(new)* — Data-quality and freshness checks, quarantine handling, and alerting.
- [`docs/FEATURE_MONITORING.md`](FEATURE_MONITORING.md) *(new)* — SLIs, dashboards, and alerting strategy for feature ingestion/serving.
- [`docs/FEATURE_GOVERNANCE.md`](FEATURE_GOVERNANCE.md) — Privacy posture, IAM baselines, retention, and consent/audit flows.
- [`docs/FEATURE_LIFECYCLE.md`](FEATURE_LIFECYCLE.md) — Dataset lifecycle, retention gates, and archival strategy.
- [`docs/FEATURE_PERF.md`](FEATURE_PERF.md) — Performance benchmarks and optimisation guidelines.
- [`docs/FEATURE_SLO.md`](FEATURE_SLO.md) *(new)* — Agreed SLOs, alerts, and handoff checklist.
- [`docs/FEATURE_BACKFILL.md`](FEATURE_BACKFILL.md) *(new)* — Resumable backfill CLI & ledger guidance.
- [`docs/FEATURE_SKEW.md`](FEATURE_SKEW.md) *(new)* — Training-serving skew detection workflow.
- [`docs/FEATURE_VIEWS.md`](FEATURE_VIEWS.md) *(new)* — View definitions and PIT materialisation.

## Operational Runbooks

- [`docs/RUNBOOKS.md`](RUNBOOKS.md) — Backup/restore, retention automation, and links to service-specific runbooks.
- [`infra/automation/analytics-retention.cron`](../infra/automation/analytics-retention.cron) — Production cron entries for nightly analytics retention sweeps.

Keep this index in sync when adding new operator-facing documentation.
