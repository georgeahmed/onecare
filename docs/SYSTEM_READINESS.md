System Readiness — Backend Platform

Purpose
- Single checklist to declare the entire backend “stable”. It aggregates service‑level gates (BE‑01 orchestrator) and cross‑team dependencies (BE‑02 bus, Integrations, SRE, QA).

How to Use
- Owners update their sections and link PRs/tests. All items must be green for a “stable” declaration.

Owners
- Orchestrator: Backend Engineer 01 (BE‑01)
- Bus & Delivery: Backend Engineer 02 (BE‑02)
- Integrations: Integrations Engineer 01 (IN‑01)
- Infra/CI/Security/Observability: DevOps/SRE 01–02
- Contracts/E2E: QA Automation 01–02

Core Gates
- [ ] Contracts synced: schemas → TS/Py codegen across repos; DRY check passes
- [ ] Security: zero‑trust ingress, redaction, consent enforcement across flows
- [ ] Idempotency/outbox: distributed semantics defined and implemented (or documented interim)
- [ ] Delivery: at‑least‑once with DLQ and tooling; ordering/partitioning strategy approved
- [ ] Resilience: timeouts, retries, circuit breakers, flow control/backpressure
- [ ] Observability: traces/metrics/logs; SLOs; alerts; dashboards
- [ ] Operations: probes, graceful shutdown, secrets/TLS, backups/DR
- [ ] Performance: p50/p95 within SLO under target load; soak test passes
- [ ] QA: contract tests pass; critical E2Es pass deterministically

Orchestrator (BE‑01)
- See docs/RELEASE_READINESS.md. All items must be green.

Bus & Delivery (BE‑02)
- [ ] NATS adapter with durable subs + ack deadlines (BE‑02.4a)
- [ ] DLQ subject + DlqEvent schema enforcement (BE‑02.4b)
- [ ] Reconnect/backoff with jitter; status events and metrics (BE‑02.5a/5b)
- [ ] At‑least‑once semantics; dedupe key propagation (BE‑02.6a/6b)
- [ ] Ordering/partitioning documented and tested (BE‑02.7/BE‑02.18)
- [ ] Flow control/backpressure configured and tested (BE‑02.8)
- [ ] Security (TLS, creds, ACLs); rotation readiness (BE‑02.9)
- [ ] Observability metrics/spans; correlation propagation (BE‑02.10)
- [ ] Health/readiness integrates bus status (BE‑02.11)
- [ ] Contract/topic allowlist checks (BE‑02.12)
- [ ] Advanced DLQ/retry policy and requeue tooling (BE‑02.13)
- [ ] Parity tests vs MemoryBus (BE‑02.14)
- [ ] Perf/soak baselines (BE‑02.19)
- [ ] Runbooks/alerting for storms/backlogs (BE‑02.20)

Integrations (IN‑01)
- [ ] FHIR client: timeouts/retries, correlation, metrics (IN‑01.1)
- [ ] Bundle upsert: $transaction with resilience; metrics (IN‑01.2)
- [ ] Methods for Task/Appointment/DocumentReference; Object Store wiring (IN‑01.3/01.4)
- [ ] OIDC + consent check stub with deny‑by‑default; redaction (IN‑01.5)
- [ ] YAML config loader; floors/ceilings; validation (IN‑01.6)
- [ ] Profile validate() stub and mapping to orchestrator errors (IN‑01.7)

SRE (01–02)
- [ ] NATS in compose; env wiring; readiness gating (SRE‑01.1)
- [ ] Secrets management baseline; templates & rotation policy (SRE‑01.2)
- [ ] CI caching + codegen checks (SRE‑01.3)
- [ ] Resource limits/ulimits; restart policies (SRE‑01.4)
- [ ] Backup/restore stubs + runbook (SRE‑01.5)
- [ ] OTEL collector; export to dev backends (SRE‑01.6, SRE‑02.1)
- [ ] Log format policy; correlation IDs; redaction utility (SRE‑02.2, SEC‑01.1)
- [ ] SLOs defined and alert templates in place (SRE‑02.3, SRE‑02.4)
- [ ] Node OTel init + correlation context (SRE‑02.5)

QA Automation (01–02)
- [ ] Schema harness (Ajv) with compiled validators; positive/negative sets (QA‑01.1)
- [ ] Contract tests for core events + envelopes (QA‑01.2)
- [ ] E2E: portal → orchestrator → triage task with correlation (QA‑01.3)
- [ ] OpenAPI validation for Python services (QA‑01.5)
- [ ] Additional suites (pharmacy, ICS) (QA‑01.6)

Decision & Sign‑Off
- [ ] All owner sections green
- [ ] System demo performed (success + induced failure cases)
- [ ] Rollback plan validated and rehearsed

