Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.14.md) | [Next](SRE-01.16.md)

Task: SRE-01.15 — Supply chain security (image signing/provenance, vuln/license scans)

Context
- Improve software supply chain security: sign container images, attach provenance, and scan for vulnerabilities and license issues in CI.

Files
- .github/workflows/ci.yml, cd.yml
- docs/SECURITY.md (supply chain)

Steps
1) Integrate `cosign` to sign built images and generate SLSA provenance (where feasible); store signatures in registry.
2) Run vulnerability scans on images and dependencies; include license compliance checks; fail on high‑severity (soft‑fail initially).
3) Document verification steps for deploy (verify signature before promotion) and key management policies.

Acceptance Criteria
- Images signed; scan reports attached; docs for verification exist.

Validate
- Build pipeline shows signed images; scan reports generated; manual `cosign verify` succeeds.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.15' && make team-status-write

