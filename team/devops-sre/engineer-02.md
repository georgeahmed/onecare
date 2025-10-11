Engineer: DevOps/SRE 02

Role: DevOps/SRE (Observability/Security)
Stack: OpenTelemetry, SIEM, Policy

Responsibilities
- Centralized logs/metrics/traces; baseline security controls.

Initial Tasks
- OTEL collector; tracing/metrics wiring; alerting policies.

Start Here
- Algorithm.md: 12) Observability; SLOs and alerts
- Observability: packages/observability/src/*

Status: in-progress
Progress: 43%

Dependencies
- devops-sre/engineer-01 (Infra)
- data-engineering/engineer-01 (Metrics sink)

Tasks
- [x] SRE-02.1 — Add OpenTelemetry Collector to compose (OTLP exporters)
- [x] SRE-02.2 — Correlation IDs in logs + log format policy
- [x] SRE-02.3 — Define SLOs (triage p95, scribe p95, uptime) docs + CI guard
- [ ] SRE-02.4 — Alerts templates for triage latency breach, scribe backlog
- [ ] SRE-02.5 — Node OTEL init + correlation context
- [ ] SEC-01.1 — Logging redaction utility
- [ ] SEC-01.2 — AuthZ matrix documentation (scopes/actions)
 - [ ] SRE-02.6 — Centralized logs stack (Loki/ELK) with correlationId parsing and retention
 - [ ] SRE-02.7 — Trace sampling policy (tail-based; error/latency bias) and config
 - [ ] SRE-02.8 — Metrics pipeline hardening (cardinality limits, relabeling, histograms)
 - [ ] SRE-02.9 — Alert hygiene (dedupe, silence windows, runbook links) and on-call guide
 - [ ] SEC-01.3 — CSP baseline and security headers policy (frontend/proxy)
 - [ ] SEC-01.4 — Dependency scanning gates (npm/pip/audit) and license policy
 - [ ] SEC-01.5 — Secrets scanning in CI and pre-commit (trufflehog/gitleaks)
 - [ ] SEC-01.6 — Egress allowlist enforcement and SSRF guard (proxy/policies)
 - [ ] SEC-01.7 — Pen-test checklist and hardening backlog (containers/network/app)
