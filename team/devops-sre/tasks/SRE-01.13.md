Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.12.md) | [Next](SRE-01.14.md)

Task: SRE-01.13 — Network security (cert‑manager, mTLS, Ingress, egress allowlist, NetworkPolicies)

Context
- Secure cluster networking with mTLS, trusted certificates, ingress control, and egress restrictions.
- Current state: `infra/k8s/networkpolicies/egress-deny.yaml` provides a draft deny-all, but there is no cert-manager install, no ingress resources, and no documented egress allowlist.

Files
- infra/k8s/* (cert‑manager, ingress controller, networkpolicies)
- docs/SECURITY.md (network section)

Steps
1) Install cert‑manager and commit Issuer/Certificate manifests (dev/staging/prod), ensuring ingress endpoints terminate TLS with managed certs.
2) Enable mTLS between internal services (service mesh or node-local sidecars); document trust boundaries and certificate rotation expectations.
3) Flesh out ingress and egress NetworkPolicies: default-deny + explicit allowlists (including external dependencies), strict header checks, and documentation in `docs/SECURITY.md`.

Acceptance Criteria
- Certificates issued; ingress TLS works; network policies enforced; docs updated.

Validate
- Deploy to kind/minikube; verify TLS and blocked egress to disallowed IPs.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.13' && make team-status-write
