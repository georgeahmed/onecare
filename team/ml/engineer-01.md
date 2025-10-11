Engineer: ML 01

Role: ML Engineer (Safety Gate NER/Classifier)
Stack: PyTorch, HF Transformers

Responsibilities
- Red-flag NER + emergency classifier; thresholds; latency budget.

Initial Tasks
- Prototype NER/classifier; expose FastAPI endpoint with timeout and correlationId propagation.

Start Here
- Algorithm.md: 2.2 Urgent‑Safety Gate (transformer-based)
- Config: config/nhs_gp_defaults.yaml (safety_gate thresholds)

Status: planned
Progress: 0%

Dependencies
- backend/engineer-06 (Access Gate)
- telephony-voice/engineer-01 (ASR input)
- mlops/engineer-01 (Deploy)

Tasks
- [ ] ML-01.1 — Curate sample dataset + red-flag labeling schema
- [ ] ML-01.2 — NER model setup (BioClinicalBERT) + inference wrapper
- [ ] ML-01.3 — Emergency classifier head + threshold tuning (config-driven)
- [ ] ML-01.4 — Safety decision function (combine NER/cls + thresholds)
- [ ] ML-01.5 — Add timeout + rules fallback (RED_FLAG_SET) per config
- [ ] ML-01.6 — FastAPI /analyze Pydantic models + unit tests
- [ ] ML-01.7 — Latency budget checks (p50/p95) + metrics logging
- [ ] ML-01.8 — PII redaction in logs + sampling policy
 - [ ] ML-01.9 — Contracts-first models and validators (schemas, codegen, compiled validators)
 - [ ] ML-01.10 — Observability: correlationId propagation, Prometheus metrics, OTel spans
 - [ ] ML-01.11 — Health/readiness probes + warmup (model load, cold-start budget)
 - [ ] ML-01.12 — Performance: batching/quantization (optional), CPU/GPU toggle, memory caps
 - [ ] ML-01.13 — Robust error envelopes (no stack traces); input limits and validation
 - [ ] ML-01.14 — Concurrency & backpressure (worker limits, time budgets, 429/503 on overload)
 - [ ] ML-01.15 — Security & privacy hardening (no PHI logs, secrets, SSRF off, pinned deps)
 - [ ] ML-01.16 — Dataset governance + golden set (versioning, labeling guide, eval metrics)
 - [ ] ML-01.17 — A/B model version switch + config gating (safe rollback)
 - [ ] ML-01.18 — Documentation & ADRs (model choice, thresholds, fallback, ops)
  - [ ] ML-01.19 — Evaluation harness (per-class precision/recall/F1, ROC/PR, calibration)
  - [ ] ML-01.20 — Bias/fairness audit and mitigations (language/variant robustness)
  - [ ] ML-01.21 — Threshold calibration + temperature scaling (reproducible tuning)
  - [ ] ML-01.22 — Adversarial input and toxicity guard (sanity checks; limits)
  - [ ] ML-01.23 — Determinism/reproducibility (seeds, pinned deps, model card + hashes)
  - [ ] ML-01.24 — Drift monitoring hooks + golden set CI (handoff to MLOps)
  - [ ] ML-01.25 — Multilingual handling (native vs translate; lang-detect fallback)
  - [ ] ML-01.26 — Resource profiling & capacity plan (throughput, p95, memory)
  - [ ] ML-01.27 — Supply chain security (SBOM, CVE scan, pinned wheels)

Platform Checklist (pre-flight)
- Contracts: generated Pydantic models from schemas; Ajv in TS side validates envelope; Python validates request/response models.
- Observability sinks: logs + metrics + traces; correlationId header `x-correlation-id` roundtripped.
- Resource limits configured (CPU/mem); GPU optional; model weights pinned and checksummed.
