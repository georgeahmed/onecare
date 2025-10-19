# Feature Lifecycle & Retention

| Feature Set | Online TTL | Offline Retention | Owner | Notes |
| --- | --- | --- | --- | --- |
| triage-core | 10 minutes | 180 days | MLOps | Purge daily via compaction job `feature_compact.js`. |
| acuity-signal | 15 minutes | 180 days | ML Eng | Aligns with retraining cadence. |

## Processes

- **Compaction**: run `node scripts/feature_compact.js --feature-set <name>` weekly to merge incremental snapshots.
- **Retention enforcement**: Data Engineering applies table policies (DE-01.16). Coordinate changes by filing a joint ticket.
- **Review cadence**: revisit lifecycle entries quarterly; update table when feature sets are added or thresholds change.

## Compliance

- Retention aligns with privacy policies in `docs/security/SECRETS_POLICY.md` and data classification levels.
- Archive exports older than the retention window must be deleted or anonymised per the governance checklist.
