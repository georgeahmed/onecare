Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-03.7.md) | Next: —

Task: SEC-03.8 — WAF/rate‑limit/DoS policies for public endpoints

Context
- Provide baseline ingress protections for public endpoints to mitigate abuse and DoS.

Files
- docs/security/WAF_POLICY.md (new)

Steps
1) Document rate‑limit defaults per endpoint class (auth, form submit, booking) and suggested WAF/Ingress rules (IP throttling, bot filters).
2) Include guidance for geo/IP allow/deny if applicable; log sampling and privacy considerations.

Acceptance Criteria
- Policy doc exists; references to SRE implementation tasks.

Validate
- Review with SRE; include in deployment notes.

Status Update
- make engineer-done ENGINEER=security/engineer-02 TASK='SEC-03.8' && make team-status-write

