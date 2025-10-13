Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.17.md) | [Next](SEC-02.3.md)

Task: SEC-02.2 — Data classification & retention policy

Context
- Classify data handled by the system and define retention and minimization rules mapped to config and code enforcement points.

Files
- docs/security/DATA_CLASSIFICATION.md (new)
- config/nhs_gp_defaults.yaml (privacy_policy.retention_days)

Steps
1) Define classes: Public, Internal, Confidential (PHI/PII). Map each field in major payloads (events, FHIR refs) to a class.
2) Set retention policies per class; align with config retention_days; list enforcement points (Object Store TTL, audit WORM, analytics/minimization).
3) Document masking/aggregation rules for analytics; no PHI in analytics.metrics labels.

Acceptance Criteria
- Classification + retention doc exists; enforcement points listed; owners assigned.

Validate
- Walkthrough with Data Eng and SRE; update docs.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.2' && make team-status-write

