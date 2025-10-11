Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-03.2.md) | [Next](SEC-03.4.md)

Task: SEC-03.3 — Dependency update automation with security gates

Context
- Keep dependencies fresh with Renovate/Dependabot while gating merges on passing tests and security scans.

Files
- .github/renovate.json or dependabot.yml (new)
- docs/security/DEPENDENCY_POLICY.md (new)

Steps
1) Configure Renovate/Dependabot for Node/Python; group updates sensibly; schedule windows.
2) Require CI green (tests, codegen:check, audits) before auto‑merge; label security‑related updates.
3) Document update policy and exception handling.

Acceptance Criteria
- Automation active; merges gated; policy documented.

Validate
- Open a sample PR from bot; observe gates.

Status Update
- make engineer-done ENGINEER=security/engineer-02 TASK='SEC-03.3' && make team-status-write

