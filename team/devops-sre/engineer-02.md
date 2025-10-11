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

Status: planned
Progress: 0%

Dependencies
- devops-sre/engineer-01 (Infra)
- data-engineering/engineer-01 (Metrics sink)

Tasks
- [ ] SRE-02.1 — Add OpenTelemetry Collector to compose (OTLP exporters)
- [ ] SRE-02.2 — Correlation IDs in logs + log format policy
- [ ] SRE-02.3 — Define SLOs (triage p95, scribe p95, uptime) docs + CI guard
- [ ] SRE-02.4 — Alerts templates for triage latency breach, scribe backlog
- [ ] SRE-02.5 — Node OTEL init + correlation context
- [ ] SEC-01.1 — Logging redaction utility
- [ ] SEC-01.2 — AuthZ matrix documentation (scopes/actions)
