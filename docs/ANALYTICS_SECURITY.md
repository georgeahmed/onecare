# Analytics Security & Governance

## Access Model

Analytics storage is segmented into three logical tiers:

| Tier | Path / Service | Purpose | Default Retention | Principal |
|------|----------------|---------|-------------------|-----------|
| Hot | `var/analytics/metrics.jsonl`, `var/analytics/backfill/` | Raw event drops awaiting rollup | 30 days | Analytics ingest worker (`analytics-ingest`) |
| Warm | `var/analytics/lake/` (Parquet partitions) | Aggregated rollups served to BI/ML | 12 months | Analytics compute (`analytics-rollup`), retention job |
| Cold | `var/analytics/cold/` (object store tier) | Archived rollups/lineage satisfying compliance holds | 7 years | Retention job, audit/break-glass role |

Principals and policies are codified in `config/analytics/iam-policies.json` (see below). Key tenets:

- **Least privilege** — each workload receives the minimal S3/Object Storage and KMS permissions required for its
  tier. For example, the rollup job can `PutObject` into warm storage but not read the cold tier, while the
  retention job can move partitions but cannot read raw metric files.
- **Segregation of duties** — audit/break-glass roles have read-only access to hot/warm storage and require MFA +
  ticket references. Production support staff are limited to retention operations via automation.
- **Network** — analytics workers run on internal subnets. Egress is restricted to approved destinations (object
  storage, observability) via firewall rules.

## IAM Alignment Matrix

Security and Ops reviewed the sample IAM documents on **2025-10-19** (ticket `SEC-3241`). The table below maps the
agreed production resources so the generated policies reference the correct buckets and KMS aliases.

| Environment | Hot Bucket | Warm Bucket | Cold Bucket | KMS Aliases |
|-------------|------------|-------------|-------------|-------------|
| dev | `onecare-analytics-hot-dev` | `onecare-analytics-warm-dev` | `onecare-analytics-cold-dev` | `alias/analytics-hot-dev`, `alias/analytics-warm-dev`, `alias/analytics-cold-dev` |
| staging | `onecare-analytics-hot-staging` | `onecare-analytics-warm-staging` | `onecare-analytics-cold-staging` | `alias/analytics-hot-staging`, `alias/analytics-warm-staging`, `alias/analytics-cold-staging` |
| prod | `onecare-analytics-hot-prod` | `onecare-analytics-warm-prod` | `onecare-analytics-cold-prod` | `alias/analytics-hot-prod`, `alias/analytics-warm-prod`, `alias/analytics-cold-prod` |

Any Infra changes to bucket naming or KMS aliasing must update both `config/analytics/iam-policies.json` and this
matrix before redeploying the retention/backfill automation.

## Encryption & Secrets

- **At-rest** — all analytics buckets use customer-managed KMS keys (`alias/analytics-hot`, `alias/analytics-warm`,
  `alias/analytics-cold`). Keys are rotated annually and scoped to analytics service accounts. Parquet files written
  by `scripts/analytics_storage_layout.js` must enable server-side encryption (SSE-KMS).
- **In-transit** — ingestion over TLS 1.2+, object store requests enforce HTTPS, and internal calls use mTLS when
  traversing service boundaries (`@onecare/bus`, Retention job). `scripts/analytics_retention.js` must upload to
  cold storage via signed HTTPS URLs.
- **Secrets** — credentials (object store access keys, KMS grant tokens, warehouse auth) live in Vault under
  `secret/data/analytics/*`. CI jobs fetch ephemeral tokens via OIDC. Tokens rotate every 90 days; automation
  emits PagerDuty warnings at 80 days to avoid expiration.

## Logging & Audit

- **Structured logging** — analytics jobs log structured JSON with `runId`, `dataset`, `action`, and `correlationId`.
  PHI/PII is prohibited; only aggregate metrics and anonymised identifiers appear in logs.
- **Access logs** — object storage buckets have access logging enabled to a dedicated `analytics-audit-logs`
  bucket. CloudTrail / CloudWatch rule alerts on sensitive operations (e.g., `DeleteObject` outside retention job,
  `GetObject` by non-whitelisted roles).
- **Reviews** — security performs quarterly reviews of:
  1. IAM policies against the sample baselines in `config/analytics/iam-policies.json`.
  2. Vault secret leases / rotation timestamps.
  3. Retention reports from `scripts/analytics_retention.js` (ensuring tiering/deletion succeeded).
- **Break-glass** — audit role `analytics-audit-readonly` is disabled by default and requires Security approval +
  paired login (two-person rule). Access is logged with ticket number and auto-revoked after 24h.

## Operational Safeguards

- **Retention** — `scripts/analytics_retention.js` enforces TTLs and emits `analytics.retention.*` metrics. Cold
  tier exports must be encrypted and signed. Dry-run mode is required before changing TTL values in production.
- **Backfill** — `scripts/analytics_backfill.js` records ledger entries with `gitCommit` and schema IDs, enabling
  traceable reprocessing. Resume mode prevents uncontrolled duplicate writes.
- **Lineage** — every analytics job emits lineage events (see `docs/ANALYTICS_LINEAGE.md`) to maintain provenance
  and support audit queries.

## Incident Response

1. **Detection** — alerts fire on unusual S3 access patterns, lineage gaps, retention failures, or ingestion
   authentication errors.
2. **Containment** — revoke affected Vault tokens, rotate KMS grants, and pause retention/job schedulers if needed.
3. **Remediation** — replay via `analytics_backfill` or restore from tiered cold storage as documented in
   `docs/ANALYTICS_BACKFILL.md`.
4. **Postmortem** — include lineage excerpts, IAM diff, and retention job status in the report. Update this document
   if policy changes are required.

## References

- `config/analytics/iam-policies.json` — Sample IAM policies for ingest, rollup, retention, and audit roles.
- `docs/adr/2025-10-19-analytics-retention.md` — Lifecycle policy underpinning retention automation.
- `docs/ANALYTICS_BACKFILL.md` — Backfill governance and ledger usage.
- `docs/ANALYTICS_LINEAGE.md` — Lineage event format and ingestion guidance.
