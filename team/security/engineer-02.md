Engineer: Security 02

Role: Application Security Engineer (AppSec/SDLC)
Stack: Semgrep/CodeQL, Fuzzing, IaC Scanning, WAF/Policies

Responsibilities
- Embed security into the SDLC and runtime: code scanning, secret prevention, fuzzing, SSRF hardening, CSP/WAF, IaC scanning, disclosure process.

Initial Tasks
- Establish secure SDLC guardrails in CI/PRs; turn on curated scanners; add targeted fuzzers and SSRF test harnesses; align with SRE and Integrations.

Start Here
- Docs: docs/SECURITY_HEADERS.md, docs/security/* (policies, IRP, DPIA, OIDC hardening)
- CI: .github/workflows/ci.yml
- Code: apps/*, packages/*, services-py/*

Status: needs-fixes
Progress: 0%

Dependencies
- devops-sre/engineer-02 (Observability/Security pipeline)
- integrations/engineer-01 (OIDC/JWT), backend team (orchestrator), frontend team (CSP/i18n)

Tasks
- [ ] SEC-03.1 — Secure SDLC policy & PR checklist integration
- [ ] SEC-03.2 — Code scanning (Semgrep/CodeQL) curated rules + severity gates
- [ ] SEC-03.3 — Dependency update automation (Renovate/Dependabot) with security review gates
- [ ] SEC-03.4 — Secrets prevention hooks (pre‑commit/pre‑receive) + developer guidance
- [ ] SEC-03.5 — HTTP/API fuzzing harness (property‑based + ZAP baseline) for key endpoints
- [ ] SEC-03.6 — SSRF test suite (egress mocks; private IP redirection tests)
- [ ] SEC-03.7 — AuthZ matrix → automated tests (actors/actions/resources)
- [ ] SEC-03.8 — WAF/rate‑limit/DoS policies for public endpoints (ingress config + docs)
- [ ] SEC-03.9 — CSP enforcement + Subresource Integrity (SRI) for FE assets
- [ ] SEC-03.10 — TLS config audit (min versions/ciphers) + automated checks
- [ ] SEC-03.11 — IaC scanning (k8s/tf) with tfsec/kubeaudit and remediation backlog
- [ ] SEC-03.12 — Backdoor/debug surface audit (ports, debug flags, default creds)
- [ ] SEC-03.13 — Responsible disclosure & bug bounty triage workflow
- [ ] SEC-03.14 — SBOM drift detection and SCA policy enforcement in CI
- [ ] SEC-03.15 — Attack surface inventory (services, endpoints, data stores) + owner map
- [ ] SEC-03.16 — SSO/RBAC hardening for internal tools (least privilege)
- [ ] SEC-03.17 — Red/purple‑team tabletop scenarios and follow‑ups
- [ ] SEC-03.18 — Documentation & developer training refresh (checklists, examples)

