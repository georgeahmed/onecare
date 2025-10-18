# ML Team Remaining Task Plan

Sequenced plan for the outstanding ML safety-gate deliverables. Each step lists the immediate focus and points to the next task to tackle once the step is done so the team can move through the backlog without re-triage.

## Phase 1 — Production Hardening

1. **ML-01.8 — PII redaction tests & logging policy**
   - Add deterministic unit coverage for `_redact_pii` and document the sampling guard so production logs stay PHI-free.
   - *Follow-up:* move straight into **ML-01.10** to extend observability around those logs.
2. **ML-01.10 — Correlation-aware observability**
   - Wrap the NER, classifier, and decision calls in `common.otel.span` contexts and expose structured counters on `/metrics`.
   - *Follow-up:* continue with **ML-01.11** to wire warm-ups into the readiness checks.
3. **ML-01.11 — Health/readiness warmup**
   - Report model versions/hashes from `/ready`, run an eager warmup inference, and time the cold-start budget.
   - *Follow-up:* tackle **ML-01.12** once readiness is truthful.
4. **ML-01.12 — Performance controls**
   - Implement optional micro-batching, device toggles, and safe quantisation fallbacks with metrics for queue depth.
   - *Follow-up:* proceed to **ML-01.13** so fast paths still fail safely.
5. **ML-01.13 — Error envelopes & ingress guardrails**
   - Enforce content-type/size limits and map failures into the documented error envelope.
   - *Follow-up:* advance to **ML-01.14** for overload handling.
6. **ML-01.14 — Concurrency and backpressure**
   - Add request semaphores, queue metrics, and 429/503 fallbacks when budgets are exceeded.
   - *Follow-up:* shift focus to **ML-01.15** to lock down security posture.
7. **ML-01.15 — Security & dependency hardening**
   - Pin Python deps with hashes, restrict outbound HTTP targets, and document secrets-usage constraints.
   - *Follow-up:* with the platform hardened, execute **ML-01.17**.
8. **ML-01.17 — Configurable model rollouts**
   - Surface active NER/classifier versions on `/ready`, honour env overrides, and capture rollback docs.
   - *Follow-up:* close Phase 1 with **ML-01.18**.
9. **ML-01.18 — Safety gate ADR & ops docs**
   - Publish the decision-process ADR (model choice, thresholds, fallback) and update runbooks.
   - *Follow-up:* begin the data governance stream at **ML-01.16**.

## Phase 2 — Data Governance & Evaluation

10. **ML-01.16 — Dataset governance & golden set**
    - Version the curated dataset, add the golden-set JSON, and document labeling guidance under `docs/ml/`.
    - *Follow-up:* jump to **ML-01.19** to leverage the curated data.
11. **ML-01.19 — Evaluation harness**
    - Build metric utilities (PR/ROC/ECE) and persist baseline JSON artefacts for the golden set.
    - *Follow-up:* run bias checks in **ML-01.20**.
12. **ML-01.20 — Bias & fairness audit**
    - Add fairness slices (language/demographic proxies) and capture mitigations in docs.
    - *Follow-up:* feed the findings into **ML-01.21** for calibrated thresholds.
13. **ML-01.21 — Threshold calibration & temperature scaling**
    - Formalise the calibration pipeline, export chosen thresholds, and sync them into config with hashes.
    - *Follow-up:* stress-test robustness via **ML-01.22**.
14. **ML-01.22 — Adversarial/toxicity guard**
    - Implement adversarial input sanitisation and toxicity scoring with fail-safe responses.
    - *Follow-up:* ensure builds stay reproducible in **ML-01.23**.
15. **ML-01.23 — Determinism & reproducibility**
    - Lock seeds, record model digests, publish the model card, and verify deterministic inference.
    - *Follow-up:* wire CI hooks for drift by tackling **ML-01.24**.
16. **ML-01.24 — Drift monitoring hooks**
    - Emit drift metrics, schedule golden-set CI checks, and handoff interfaces to MLOps.
    - *Follow-up:* broaden language coverage with **ML-01.25**.

## Phase 3 — Globalisation & Operational Scaling

17. **ML-01.25 — Multilingual handling**
    - Add language detection, configure translate-or-native routing, and extend tests for non-English cases.
    - *Follow-up:* run load profiling in **ML-01.26**.
18. **ML-01.26 — Resource profiling & capacity plan**
    - Produce throughput/p95/memory profiles (CPU vs GPU) and document scaling recommendations.
    - *Follow-up:* conclude with **ML-01.27**.
19. **ML-01.27 — Supply-chain security**
    - Generate SBOMs, integrate CVE scanning, and pin model wheels with signed hashes.
    - *Follow-up:* schedule a cross-team readiness review to validate all Phase 1–3 deliverables are in place.

