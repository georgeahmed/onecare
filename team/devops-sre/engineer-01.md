Engineer: DevOps/SRE 01

Role: DevOps/SRE (Infra/CI/CD)
Stack: IaC, CI/CD, Docker, Observability

Responsibilities
- Cloud infra, CI pipelines, secrets, reliability.

Initial Tasks
- Broker/persistence infra; secrets management; autoscaling; backup/restore.

Start Here
- Algorithm.md: 12) Security, Privacy, Audit & Observability
- CI: .github/workflows/ci.yml; docker-compose.yml (NATS)

Status: in-progress
Progress: 57%

Dependencies
- backend/engineer-02 (Bus impl)
- integrations team (FHIR/GP Connect endpoints)

Tasks
- [x] SRE-01.1 — Configure NATS (URL, creds) in compose; health probes; readiness gating
- [x] SRE-01.2 — Secrets management baseline (templates, rotation policy), no secrets in git
- [x] SRE-01.3 — CI caching for Node/Python deps; add codegen checks in CI
- [x] SRE-01.4 — Resource limits/requests; container health/restart policy; ulimits where needed
- [ ] SRE-01.5 — Backup/restore stub scripts + runbook (bus streams, config)
- [ ] SRE-01.6 — OTEL collector in compose; export to stdout/OTLP (dev)
- [ ] SRE-01.7 — TLS for bus + services in dev/prod parity (self‑signed in dev)
 - [ ] SRE-01.8 — Supply chain: SBOM + vulnerability scanning in CI (fail thresholds; allowlist policies)
 - [ ] SRE-01.9 — Data retention/minimization: log/event retention policies + purge tooling (DLQ, logs)
 - [ ] SRE-01.10 — Observability stack: OTEL collector, Prometheus/Grafana dashboards, logs (correlationId)
 - [ ] SRE-01.11 — SLOs & alerting (latency p95, error rates, DLQ growth, readiness flaps; error budgets)
 - [ ] SRE-01.12 — Secrets manager integration (Vault/KMS), sealed‑secrets, rotation runbook
 - [ ] SRE-01.13 — Network security (cert‑manager, mTLS, Ingress, egress allowlist, k8s NetworkPolicies)
 - [ ] SRE-01.14 — Backup/restore verification + DR (scheduled backups, test restores, RTO/RPO)
 - [ ] SRE-01.15 — Supply chain security (image signing/provenance, vuln/license scans)
 - [ ] SRE-01.16 — Kubernetes baseline (manifests/Helm: resources, probes, HPA, NetworkPolicies)
 - [ ] SRE-01.17 — CI/CD pipeline: build→test→codegen:check→SBOM→scan→docker push→staging canary→prod promote/rollback
