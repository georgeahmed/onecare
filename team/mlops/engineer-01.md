Engineer: MLOps 01

Role: MLOps Engineer (Packaging/Deploy)
Stack: FastAPI, Docker, CI/CD

Responsibilities
- Package ML services; rollout/canary; observability.

Initial Tasks
- Build images; add health/readiness; configure tracing/metrics.

Start Here
- Algorithm.md: 13) MLOps & Governance
- CI: .github/workflows/ci.yml; Dockerfiles under services-py/*

Status: in-progress
Progress: 86%

Dependencies
- ml team (services)
- devops-sre team (infra)

Tasks
- [x] MO-01.1 — Add health/readiness endpoints to Python services (FastAPI /health, /ready)
- [x] MO-01.2 — Containerize safety_gate_service and scribe_service with resource limits
- [x] MO-01.3 — Add OpenTelemetry middleware/hooks (trace + metrics) to both services
- [x] MO-01.4 — CI step to build and push Docker images (tags: git sha, semver)
- [x] MO-01.5 — Runtime env + secrets layout (keys, endpoints) documentation
- [x] MO-01.6 — Base dashboards for latency (p50/p95), error rate, throughput
- [ ] MO-01.7 — Vulnerability & secrets scanning in CI
 - [ ] MO-01.8 — Rollout strategies: blue/green, canary, and shadow (traffic splitting + rollback)
 - [ ] MO-01.9 — Autoscaling & concurrency (HPA/Knative), request time budgets, max in-flight
 - [ ] MO-01.10 — GPU/CPU scheduling & resource classes (node selectors/taints; memory/cuda caps)
 - [ ] MO-01.11 — Model/version registry integration (metadata, hashes, promotion workflow)
 - [ ] MO-01.12 — Shadow evaluation harness (compare vNext vs vCurrent with golden set)
 - [ ] MO-01.13 — SLOs & alerting (p95 latency, error rate, throttle, OOM); on-call runbook
 - [ ] MO-01.14 — Container hardening (non-root, distroless, read-only FS, seccomp, capabilities)
 - [ ] MO-01.15 — SBOM + provenance (SLSA/cosign); image policy admission docs
 - [ ] MO-01.16 — Secrets management integration (Vault/KMS) & rotation checks
 - [ ] MO-01.17 — Drift/quality monitoring hooks (export eval metrics; handoff to MLOps 02)
 - [ ] MO-01.18 — Chaos/resiliency drills (kill pods, network faults) and recovery verification
 - [ ] MO-01.19 — Cost/performance profiling (CPU/GPU utilization, cold-start time, memory)
 - [ ] MO-01.20 — Documentation & runbooks (deploy, rollback, disaster recovery)
