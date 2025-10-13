Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.11.md) | [Next](SEC-02.13.md)

Task: SEC-02.12 — Supply chain policy (SBOM/signing; image policy admission)

Context
- Define requirements for SBOMs, signed images, and admission controls to verify provenance.

Files
- docs/security/SUPPLY_CHAIN.md (new)

Steps
1) Require SBOMs for all images; signed with cosign; specify storage and verification steps.
2) Document admission policy (e.g., verify signatures) and exceptions process.
3) Align with SRE/MLOps tasks for pipeline integration.

Acceptance Criteria
- Policy published; verification steps clear; owners assigned.

Validate
- Dry‑run verification in staging.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.12' && make team-status-write

