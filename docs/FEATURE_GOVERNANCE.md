# Feature Governance & Privacy

This document defines the privacy, access, and audit controls for feature pipelines (online/offline stores, ingestion,
and data exports). Pair with:

- `docs/FEATURE_DQ.md` for data-quality enforcement.
- `docs/FEATURE_LIFECYCLE.md` for retention & archival policies.
- `config/feature-store/iam-policies.json` for sample IAM baselines.

## Data Classification

| Feature Set | Sensitivity | Allowed Identifiers | Notes |
|-------------|-------------|---------------------|-------|
| `triage-core` | Restricted (derived clinical signals) | `entityId` (hashed patient ID), correlation ID | Strip names/emails; only hashed IDs allowed in downstream exports. |
| `acuity-signal` | Confidential | `entityId`, correlation ID | Contains model outputs; treat as PHI-adjacent. |
| Aggregated telemetry | Internal | No direct PII | Safe for analytics dashboards; still redact tokens/emails. |

All feature payloads **must avoid direct PHI/PII**. Producers hash patient identifiers using the shared salt stored in
Vault (`secret/data/feature-store/crypto`). When exporting to analytics or golden datasets, continue to use hashed IDs (`entityHash`).

## IAM & Access Control

Sample IAM documents live under `config/feature-store/iam-policies.json`:

- **feature-ingest** — Write-only permissions to ingest topics/queues and append to the online store.
- **feature-reader** — Read-only access for serving path (online store + cached replicas).
- **feature-offline-writer** — Write/compact permissions for offline parquet buckets; cannot read hot data.
- **feature-audit-readonly** — Break-glass role with read-only access to all tiers (requires MFA).

Principles:

- Credentials issued via Vault dynamic secrets (24h TTL) and rotated automatically.
- Per-environment buckets/keys (`onecare-feature-hot-dev`, `...-prod`; `alias/feature-hot-prod`, etc.). Update the IAM
  samples and this doc when infra renames resources.
- Access reviews quarterly (align with `docs/security/ACCESS_REVIEWS.md`).

## Encryption & Network Controls

- **At-rest** — All buckets use KMS (`alias/feature-hot-<env>`, `alias/feature-warm-<env>`, `alias/feature-cold-<env>`).
  Online store snapshots also encrypt persistent volumes (dm-crypt or cloud disk encryption).
- **In-transit** — TLS 1.2+ for service-to-service calls; mTLS between ingestion worker and online store.
- **Secrets** — Stored in Vault. Automation retrieves tokens via OIDC; CLI workflows never print secrets.

## Audit & Logging

- Online/offline stores emit access logs to `feature-audit-logs`. Retain for ≥ 365 days.
- Ingestion/writer roles log correlation ID, feature set, entity hash (no raw IDs), and request outcome.
- DLQ payloads contain only hashed entity IDs + error metadata; purge weekly via retention cron.
- Playback and DQ tooling (see `.github/workflows/analytics-playback.yml` and `scripts/feature_store/dq.js`) log results
  without exposing feature payloads.

## Governance Checklist

- [ ] Feature payloads contain hashed identifiers only (no names, DOB, email, phone).
- [ ] Access policies deployed from `config/feature-store/iam-policies.json` (or stricter); reviewed quarterly.
- [ ] Buckets and volumes use environment-specific KMS aliases.
- [ ] DQ checker + freshness monitoring in place (`docs/FEATURE_DQ.md`, `docs/FEATURE_MONITORING.md`).
- [ ] Retention policy implemented (`docs/FEATURE_LIFECYCLE.md`); cold storage lifecycle rules configured.
- [ ] Audit logs archived and reviewed monthly; exceptions tracked with owner + remediation date.

## Review Cadence

- **Monthly** — Privacy & security sync: review new feature sets, DQ reports, and access log anomalies.
- **Quarterly** — Formal access review across IAM roles, Vault policies, and support accounts.
- **Incident Response** — For suspected privacy breach, follow `docs/security/INCIDENT_RESPONSE.md` and include feature
  governance checklist as part of the postmortem.
