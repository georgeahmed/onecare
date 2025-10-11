Task: SRE-01.13 — Network security (cert‑manager, mTLS, Ingress, egress allowlist, NetworkPolicies)

Context
- Secure cluster networking with mTLS, trusted certificates, ingress control, and egress restrictions.

Files
- infra/k8s/* (cert‑manager, ingress controller, networkpolicies)
- docs/SECURITY.md (network section)

Steps
1) Install cert‑manager; define Issuers and Certificates for services; ensure TLS for ingress.
2) Enable mTLS where feasible (service mesh optional); document trust boundaries.
3) Configure Ingress with strict host allowlists and headers; add egress NetworkPolicies to only allow approved external hosts (SSRF guard).

Acceptance Criteria
- Certificates issued; ingress TLS works; network policies enforced; docs updated.

Validate
- Deploy to kind/minikube; verify TLS and blocked egress to disallowed IPs.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.13' && make team-status-write

