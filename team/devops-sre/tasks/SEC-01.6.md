Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-01.5.md) | [Next](SEC-01.7.md)

Task: SEC-01.6 — Egress allowlist enforcement and SSRF guard

Context
- Enforce outbound egress policies at the network/proxy level to prevent SSRF and accidental data exfiltration.

Files
- infra/k8s/networkpolicies/*.yaml (new)
- docs/SECURITY.md (network egress)

Steps
1) Define egress NetworkPolicies restricting outbound traffic to allowlisted hosts for each service; block RFC1918/loopback by default.
2) Optionally set up an egress proxy with allowlists; document how to request exceptions.
3) Validate in staging by attempting disallowed connections; ensure blocks occur and are logged.

Acceptance Criteria
- Egress constrained; SSRF risks reduced; exceptions process documented.

Validate
- Attempt a blocked egress; verify deny.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SEC-01.6' && make team-status-write

