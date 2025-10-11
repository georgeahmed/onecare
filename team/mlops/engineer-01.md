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

Status: planned
Progress: 0%

Dependencies
- ml team (services)
- devops-sre team (infra)

Tasks
- [ ] MO-01.1 — Add health/readiness endpoints to Python services (FastAPI /health, /ready)
- [ ] MO-01.2 — Containerize safety_gate_service and scribe_service with resource limits
- [ ] MO-01.3 — Add OpenTelemetry middleware/hooks (trace + metrics) to both services
- [ ] MO-01.4 — CI step to build and push Docker images (tags: git sha, semver)
- [ ] MO-01.5 — Runtime env + secrets layout (keys, endpoints) documentation
- [ ] MO-01.6 — Base dashboards for latency (p50/p95), error rate, throughput
- [ ] MO-01.7 — Vulnerability & secrets scanning in CI
