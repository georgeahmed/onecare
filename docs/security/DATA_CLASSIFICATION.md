# Data Classification & Retention Policy

Last updated: 2025-10-18  
Owners: Security (primary), Data Engineering, DevOps SRE

Stakeholder review: completed 2025-10-18 with Security, Data Engineering, SRE. Next review due with the same stakeholders in Q1 2026.

## Classification Scheme

| Class | Description | Examples | Default Retention | Enforcement & Owners |
|-------|-------------|----------|-------------------|----------------------|
| **Public** | Information safe for disclosure outside OneCare. | Product documentation, public status pages. | Not restricted. | Documentation owners. |
| **Internal** | Non-public operational data without PHI/PII. | Build logs, deployment manifests, feature flags, synthetic test data. | 365 days (log retention). | DevOps SRE maintains log purge (`scripts/ops/purge-logs.sh`). |
| **Confidential** | Business-sensitive data without patient identifiers. | Financial metrics, product roadmap, partner contracts. | 730 days unless legal requires longer. | Security + Legal keep least-privilege access, store in encrypted repositories. |
| **Special Category (PHI/PII)** | Patient-identifiable or clinical information. | Portal submissions, booking details, FHIR resources, ICS referrals, audio transcripts. | 3,650 days (10 years) unless stricter NHS policy applies. Configured via `privacy_policy.retention_days` in `config/nhs_gp_defaults.yaml`. | Product teams must enforce minimisation and hashing at ingestion; SRE handles WORM storage/audit. |

## Retention & Minimisation Controls

- **Log & Trace Retention:** Application logs and OTEL traces default to 14 days (`scripts/ops/purge-logs.sh`). Sensitive identifiers must be hashed (`hashIdentifier`) before logging. See `docs/SECURITY.md#data-retention--minimization`.
- **JetStream / Event Backlog:** DLQ retention capped at 30 days (`scripts/ops/purge-dlq.sh`). Consumers must purge payload references after successful replay (see `infra/event-bus/dlq-runbook.md`).
- **Object & Audio Stores:** Per-service configurations enforce the global PHI retention (`privacy_policy.retention_days`, currently 3,650). Ambient Scribe audio stores use `AudioRetentionConfig` to match policy or the stricter per-environment override.
- **Analytics & Feature Store:** Store only aggregated metrics and hashed identifiers. Raw PHI is prohibited. Materialised feature views purge or anonymise after 90 days (Enforced via feature store purge scripts).
- **Audit & Compliance:** Audit ledgers stored in WORM-compatible storage with retention ≥ policy; rotations tracked via SRE runbooks. Access to audit data is logged and reviewed quarterly.

## Enforcement Points

| Surface | Control | Owner |
|---------|---------|-------|
| Application logging | Structured logging with PHI hashing (`@onecare/observability`). | Backend teams. |
| DLQ / NATS | DLQ purge workflow, retention metrics & alerts. | DevOps SRE. |
| Object Storage / FHIR snapshots | TTL policies tied to `privacy_policy.retention_days`; bucket lifecycle rules. | Data Engineering + SRE. |
| Analytics warehouse | Aggregation-only datasets, no direct PHI columns; masking UDFs enforced. | Data Engineering. |
| Audit ledger | Immutable append-only store with retention ≥ 10 years. | Security + SRE. |
| Backups | Automated backup workflow (`backup-nightly.yml`) and quarterly restore drills. | DevOps SRE. |

## Responsibilities

- **Security:** maintain this policy, review exceptions, chair quarterly minimisation review.
- **Data Engineering:** ensure analytics pipelines respect masking/aggregation rules and retention durations.
- **Product & Backend:** tag new data stores with classification, apply minimisation at ingress, file DPIA when needed.
- **SRE:** operate purge tooling, verify retention through automated evidence (backup logs, purge runbooks).

## Exceptions

- Any request to store PHI beyond default retention requires approval from Data Protection Officer and recording in the security backlog with an expiry review.
- Transient debugging that requires PHI must use encrypted storage with auto purge ≤ 7 days, and tickets must document the rationale.

## References

- `docs/security/THREAT_MODEL.md` — threat context for data flows.
- `docs/security/DPIA_TEMPLATE.md` & `docs/security/PRIVACY_CHECKLIST.md` — privacy review inputs.
- `docs/SECURITY.md` — operational retention controls and purge automation.
