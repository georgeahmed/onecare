Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.3.md) | [Next](SEC-02.5.md)

Task: SEC-02.4 — mTLS & cert policy (pinning/rotation)

Context
- Define policies for TLS/mTLS, certificate pinning where feasible, and rotation procedures for both client and server sides.

Files
- docs/security/TLS_POLICY.md (new)

Steps
1) Document minimum TLS versions/ciphers; when to use mTLS (internal services; bus); and exceptions.
2) Specify cert pinning strategy for outbound integrations that support it; rotation cadence and validation steps.
3) Link to SRE tasks for cert-manager and TLS in compose; provide headers/hardening guidance.

Acceptance Criteria
- Policy doc published; references to implementation tasks; rotation steps clear.

Validate
- Review with SRE; pilot rotation in staging.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.4' && make team-status-write

