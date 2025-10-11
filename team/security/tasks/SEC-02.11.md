Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.10.md) | [Next](SEC-02.12.md)

Task: SEC-02.11 — Audit logging policy (PHI‑safe; retention; WORM)

Context
- Define what events must be audited, ensure payloads are PHI‑safe, and align retention with WORM requirements.

Files
- docs/security/AUDIT_POLICY.md (new)

Steps
1) List required audit events (authn/z changes, consent checks, data access/write, safety decisions, booking/referrals) with minimal fields.
2) Define retention periods and WORM storage expectations; reference spool‑on‑fail and flusher behavior.
3) Provide redaction/minimization guidelines for audit payloads.

Acceptance Criteria
- Policy published; audit events enumerated; retention/WORM defined.

Validate
- Review audit payload examples for PHI safety.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.11' && make team-status-write

