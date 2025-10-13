Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.12.md) | [Next](SEC-02.14.md)

Task: SEC-02.13 — Egress/SSRF policy

Context
- Publish a clear policy on outbound egress and SSRF prevention, aligned with SRE network policies and application guardrails.

Files
- docs/security/EGRESS_SSRF_POLICY.md (new)

Steps
1) Define allowlist process for external hosts; deny private/link-local/loopback; no open redirects.
2) Require app-side SSRF guardrails: URL validation, DNS resolution checks, minimal headers, TLS.
3) Link to SRE NetworkPolicies and proxy options.

Acceptance Criteria
- Policy published; processes defined; cross-links added.

Validate
- Review with SRE; test blocked egress in staging.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.13' && make team-status-write

