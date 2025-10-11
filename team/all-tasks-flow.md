All Tasks Flow — Program Management

Purpose
- Provide a clear, scannable map of delivery gates, what runs in parallel, and where to find each task’s details.
- Help engineers and PMs align on sequencing, entry/exit criteria, and status hygiene.

How To Use
- Find your Task ID in `docs/TASK_INDEX.md` and your team’s folder under `team/<dept>/tasks/`.
- Work only on tasks for the current gate unless explicitly approved to parallelize.
- Update your engineer file and status when you finish: `make engineer-done ENGINEER=<team/engineer-X> TASK='<ID>' && make team-status-write`.
- For background on contracts-first and envelopes, see `docs/SCHEMAS.md` and `docs/EVENTS.md`.

Legend
- `A → B` = B starts after A completes (strict sequence)
- `[ A | B | C ]` = items can run in parallel after the previous gate completes
- Ranges `X-01.1 .. X-01.n` indicate a contiguous series of tasks

High‑Level Flow
- G0 → G1 → G2 → G3 → G4 → G5 → G6
- G2+ Observability/Security starts at G2 and runs in parallel; must land by G5.

Gate Overview (one‑liners)
- G0 Contracts & Codegen — Contracts are source of truth; codegen passes; QA seed harness ready.
- G1 Broker & Infra — Message bus reachable; secrets managed; guardrails in place (limits/backups).
- G2 Bus Adapter Minimal — Durable pub/sub working with DLQ; health/metrics exposed.
- G2+ Observability & Security — Baseline telemetry, correlation, alerts, and redaction.
- G3 Orchestrator Ingress — Zero‑trust ingress with verification, consent, and guardrails.
- G4 Domain Flows — Parallel functional tracks implement core workflows.
- G5 E2E & Performance — System E2E happy path + perf checks are green.
- G6 Release Readiness — Criteria met; runbooks/dashboards in place; system marked ready.

Gate Details

G0 — Contracts & Codegen
- QA-01.1 — Schema validation harness for TS events (Ajv)
- QA-01.2 — Contract tests for triage.input, tasks.created, appointment.created

G1 — Broker & Secrets Bootstrap
- SRE-01.1 — Configure NATS (URL, creds) in compose; health probes; readiness gating
- SRE-01.2 — Secrets management baseline (templates, rotation policy)
- SRE-01.3 — CI caching + codegen checks
- SRE-01.4 — Resource limits/requests; health/restart policy; ulimits
- SRE-01.5 — Backup/restore stub scripts + runbook
- MO-01.1 — Add health/readiness endpoints to Python services
- MO-01.2 — Containerize safety_gate_service and scribe_service with resource limits
- MO-01.3 — Add OpenTelemetry middleware/hooks (trace + metrics)
- MO-01.4 — CI step to build and push Docker images
- MO-01.5 — Runtime env + secrets layout documentation
- MO-01.6 — Base dashboards for latency (p50/p95), error rate, throughput

G2 — Bus Adapter Minimal
- BE-02.1 — Define NATS adapter skeleton
- BE-02.2 — Adapter factory + injection in orchestrator
- BE-02.3 — Basic healthcheck/metrics hooks
- BE-02.4 — NATS real connection, durable subs, basic DLQ

G2+ — Observability & Security Baseline [parallel]
- SRE-02.1 — Add OpenTelemetry Collector to compose (OTLP exporters)
- SRE-02.2 — Correlation IDs in logs + log format policy
- SRE-02.3 — Define SLOs (triage p95, scribe p95, uptime) docs + CI guard
- SRE-02.4 — Alerts templates for triage latency breach, scribe backlog
- SRE-02.5 — Node OTEL init + correlation context
- SEC-01.1 — Logging redaction utility
- SEC-01.2 — AuthZ matrix documentation (scopes/actions)
- MO-01.7 — Vulnerability & secrets scanning in CI

G3 — Orchestrator Ingress (Zero‑Trust)
- BE-01.1 — Add zero-trust gate (verify/auth/consent) plumbing
- BE-01.2 — Load typed config + enforce floors/ceilings
- BE-01.3 — Publish triage.input envelope on SAFE
- BE-01.4 — Emit audit event on success/deny
- BE-01.5 — Centralized error handling and envelope mapping
- BE-01.6 — Idempotency guard at ingress (atomic + metrics)
- BE-01.7 — Normalize→FHIR pipeline + profile validation hook
- BE-01.8 — Outbound guardrails (timeout/retry/jitter/circuit breaker)
- IN-01.6 — YAML config loader merge + floors/ceilings
- IN-01.7 — FHIR profile validate() stub

G4 — Domain Flows [parallel]
- Triage
  - BE-03.1 — Scoring function skeleton with config weights
  - BE-03.2 — De‑dup window + similarity check
  - BE-03.3 — Create FHIR Task + emit tasks.created
  - BE-03.4 — Provider assignment engine
  - BE-03.5 — Queue notifier adapter
- Booking
  - IN-02.1 — GP Connect client skeleton + auth/env (endpoint, keys)
  - IN-02.2 — Slot search mapping → internal slot list
  - IN-02.3 — Appointment create with conflict retry/handling
  - IN-02.4 — Enhanced Access constraints (windows, slot types, fairness floors; config-driven)
  - IN-02.5 — FHIR write-back links for created appointments (Task update; references; audit)
  - IN-02.6 — Observability: latency histograms, error/conflict rates, spans; correlation propagation
  - BE-04.1 — GP Connect client interface + env wiring
  - BE-04.2 — booking.search handler skeleton
  - BE-04.3 — Appointment create + conflict handling
- Pharmacy
  - IN-03.1 — CPCS client interface skeleton (typed, env/config wiring)
  - IN-03.2 — CPCS referral flow (timeouts/retries/jitter/CB; slotless fallback; error mapping)
  - IN-03.3 — ICS referral/ack client (TLS/auth; route mapping; ack semantics)
  - IN-03.4 — Billing interface placeholder (Claim/Response; TLS/auth; timeouts)
  - IN-03.5 — Observability for CPCS/ICS (structured logs, latency histograms, error counters, spans)
  - IN-03.6 — ICS org→endpoint map and routing policy (allowlist; per-org limits)
  - BE-05.1 — Eligibility rules config + evaluator
  - BE-05.2 — CPCS adapter interface
  - BE-05.3 — Referral path + outcome write‑back
- Access & Capacity
  - BE-06.1 — Portal Uptime Guard schedule
  - BE-06.2 — OOH deferral queue (persisted with TTL; flush-on-core-hours)
  - BE-06.3 — ShapeCapacity micro-release (bounded, audited)
  - BE-06.4 — Portal notify event (contract-first, idempotent, DLQ)
  - BE-06.5 — Capacity telemetry adapter (pluggable, health-aware)
- ICS & Automation
  - IN-03.6 — ICS org→endpoint map and routing policy (allowlist; per-org limits)
  - BE-07.1 — ICS ingress validation + routing policy skeleton
  - BE-07.2 — Workflow Automation triggers (policy-driven)
- Telephony/Voice
  - TV-01.1 — Telephony ingest adapter skeleton (capture audio/metadata)
  - TV-01.2 — ASR client integration; map output to CallTranscribed schema
  - TV-01.3 — Publish telephony.call.transcribed envelope (EventEnvelope)
  - TV-01.4 — Emergency transfer stub with config flags (enabled/disabled)
  - TV-02.1 — Intent classifier client skeleton + env (endpoint/keys)
  - TV-02.2 — Map intents → triage input and publish telephony.intent.classified
  - TV-02.3 — Callback window offering logic using config (by priority)
  - TV-02.4 — IVR prompts and language options (i18n, config-driven)
  - TV-02.5 — Emergency IVR handoff end‑to‑end stub
- ML Safety/Acuity/Scribe
  - ML-01.1 — Curate sample dataset + red-flag labeling schema
  - ML-01.2 — NER model setup (BioClinicalBERT) + inference wrapper
  - ML-01.3 — Emergency classifier head + threshold tuning (config-driven)
  - ML-01.4 — Safety decision function (combine NER/cls + thresholds)
  - ML-01.5 — Add timeout + rules fallback (RED_FLAG_SET) per config
  - ML-01.6 — FastAPI /analyze Pydantic models + unit tests
  - ML-01.7 — Latency budget checks (p50/p95) + metrics/observability
  - ML-01.8 — PII redaction in logs + sampling policy
  - ML-02.1 — Define feature schema + encoding utilities
  - ML-02.2 — Train baseline acuity model (XGBoost/LightGBM)
  - ML-02.3 — Calibrate thresholds (Platt/temperature) for Emergency
  - ML-02.4 — FastAPI /predict and /predict_proba endpoints
  - ML-02.5 — Save/load model artifact with versioning
  - ML-02.6 — Unit tests with fixtures for predictable outputs
  - ML-03.1 — Whisper model download + runner stub
  - ML-03.2 — Diarization pipeline integration
  - ML-03.3 — Chunking/long audio handling + transcript concat
  - ML-03.4 — Map to schemas + FastAPI /transcribe endpoint
  - ML-03.5 — Quality heuristics (confidence, silence) + unit tests
  - ML-03.6 — Audio retention controls
  - ML-04.1 — LLM client selection + env wiring (model, keys)
  - ML-04.2 — Prompt templates (system + user) for clinical summary
  - ML-04.3 — Uncertainty highlighting post-processing
  - ML-04.4 — Enforce MAX_SUMMARY_TOKENS + truncation strategy
  - ML-04.5 — FastAPI /draft endpoint + Pydantic models
  - ML-04.6 — Approval flag handling (REQUIRE_CLINICIAN_APPROVAL) + tests
- MLOps
  - MO-01.1 — Add health/readiness endpoints to Python services
  - MO-01.2 — Containerize safety_gate_service and scribe_service with resource limits
  - MO-01.3 — Add OpenTelemetry middleware/hooks (trace + metrics)
  - MO-01.4 — CI step to build and push Docker images
  - MO-01.5 — Runtime env + secrets layout documentation
  - MO-01.6 — Base dashboards for latency (p50/p95), error rate, throughput
  - MO-01.7 — Vulnerability & secrets scanning in CI
  - MO-02.1 — Feature store backend selection (ADR)
  - MO-02.2 — Implement FeatureStore.put/get in TS (@onecare/ports impl)
  - MO-02.3 — Telemetry hook to log features from triage/safety into store
  - MO-02.4 — Drift metrics (PSI/KL or mean/std diff) and alerts
  - MO-02.5 — Retention policy + purge job script
  - MO-02.6 — Unit tests and sample report generation
- Data Engineering
  - DE-01.1 — Configure analytics sink (file/DB) + env wiring
  - DE-01.2 — Implement consumer for analytics.metric envelopes -> sink
  - DE-01.3 — Daily rollup ETL (counts, p95 latencies) job script
  - DE-01.4 — Basic dashboards (arrival rate, error rate, latency)
  - DE-01.5 — Data hygiene checks (missing fields, outliers) + report
  - DE-01.6 — Analytics payload schema validation
  - DE-02.1 — Define feature schemas (JSON) + docs
  - DE-02.2 — Implement FeatureStore.put/get TS impl + tests
  - DE-02.3 — Backfill job script from historical events
  - DE-02.4 — Retention + compaction job (config-driven)
  - DE-02.5 — Sample queries/reports for ML teams
- Frontend
  - FE-01.1 — Scaffold portal intake form (practiceId, patient.id, narrative, channel)
  - FE-01.2 — Client-side JSON Schema validation for submission (errors inline)
  - FE-01.3 — Error envelope renderer per docs/ERRORS.md
  - FE-01.4 — POST /safety-check with x-correlation-id; display SafetyDecision
  - FE-01.5 — i18n scaffolding for labels/messages (en default)
  - FE-01.6 — Loading/disabled states + retry/backoff for network errors
  - FE-01.7 — Schema-driven form (optional)
  - FE-02.1 — Read/display callback windows by priority (config-driven)
  - FE-02.2 — Booking search UI (accessible list with skeletons)
  - FE-02.3 — Slot selection → idempotent booking confirmation
  - FE-02.4 — Friendly error/conflict states for booking
  - FE-02.5 — Accessibility for booking dialogs/forms (keyboard nav)
  - FE-03.1 — i18n library setup + locale switcher
  - FE-03.2 — Language preference capture (patient.locale) in submission
  - FE-03.3 — Accessibility baseline (focus, contrast) + fixes
  - FE-03.4 — Interpreter preferences UI section (config-driven)
  - FE-03.5 — Accessibility audit tooling in CI
- QA
  - QA-01.3 — E2E test: portal submission → orchestrator → triage Task
  - QA-01.4 — E2E test: booking search/create write-back
  - QA-01.5 — OpenAPI validation for Python endpoints (expand CI script)
  - QA-01.6 — Contract tests for pharmacy and ICS
  - QA-02.1 — k6 baseline load for /safety-check (latency/throughput)
  - QA-02.2 — Triage flow load test (publish triage.input → tasks.created)
  - QA-02.3 — Booking flow load test (search/create)
  - QA-02.4 — Telephony parity flow checks (IVR → ASR → intent)
  - QA-02.5 — CI integration with SLO thresholds + artifacts
  - QA-02.6 — Alert SLO tests

G5 — E2E & Performance
- QA-01.3 — E2E test: portal submission → orchestrator → triage Task
- QA-01.4 — E2E test: booking search/create write-back
- QA-01.5 — OpenAPI validation for Python endpoints (expand CI script)
- QA-01.6 — Contract tests for pharmacy and ICS
- QA-02.1 — k6 baseline load for /safety-check (latency/throughput)
- QA-02.2 — Triage flow load test (publish triage.input → tasks.created)
- QA-02.3 — Booking flow load test (search/create)
- QA-02.4 — Telephony parity flow checks (IVR → ASR → intent)
- QA-02.5 — CI integration with SLO thresholds + artifacts
- QA-02.6 — Alert SLO tests

G6 — Release Readiness
- Criteria: CI green, E2E stable, SLOs satisfied, runbooks & dashboards ready → SYSTEM_READY.

Parallelization Rules
- Gates complete in sequence; do not start G(n+1) until G(n) exits, except G2+ which runs alongside G2–G4.
- Tracks listed under G4 run concurrently after G3 completes.

References
- Task index and details — `docs/TASK_INDEX.md`
- System readiness criteria — `docs/SYSTEM_READINESS.md`
- Release checklist — `docs/RELEASE_READINESS.md`
- Team folders — `team/<dept>/tasks/`
- Engineer task template — `docs/TASK_TEMPLATE.md`

Notes
- Use the contracts‑first workflow: edit `schemas/*`, run `npm run codegen`, then implement.
- Keep PHI/PII out of logs; propagate `x-correlation-id`; enforce timeouts/retries/idempotency.
