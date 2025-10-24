# ADR: Safety Gate Model & Operations Stack

**Date:** 2025-10-21  
**Status:** Accepted

## Context
Safety Gate now runs with production-grade observability, batching, and concurrency controls. We need a durable record of:

- Why we selected the current classifier/NER/acuity stubs and how we will roll them forward.
- How latency and reliability budgets are enforced (batcher, limiter, metrics).
- The security posture (PHI redaction, outbound network rules, dependency pinning).

## Decision
1. **Model Selection & Rollouts**
   - Classifier and NER models are selected via `SAFETY_GATE_CLASSIFIER_MODEL` / `SAFETY_GATE_NER_MODEL` environment variables. Remote downloads are disabled by default; bundles must be baked into the image or mounted at runtime.
   - `/ready` reports the active classifier version, NER model name, warmup timings, and model hash so SRE can validate rollouts.
   - Rollbacks are performed by updating the env vars back to the previous model identifiers and recycling the deployment (no hot reload of in-flight workers).

2. **Performance Controls**
   - Micro-batching is opt-in (`SAFETY_GATE_ENABLE_BATCHING=1`) with defaults of four requests and 25 ms timeout. Latency histograms, batch size, and concurrency gauges are exported via Prometheus.
   - The in-app `ConcurrencyLimiter` enforces worker caps and queue depth. Overload responses follow a 429/503 envelope with retry-after headers.
   - Evaluation of golden-set regressions is automated through `data/eval_golden.py`.

3. **Security & Privacy**
   - All dependencies are pinned (`fastapi==0.109.2`, `pydantic==1.10.24`, etc.) to prevent silent upgrades.
   - Logger filters scrub emails, phone numbers, IDs, and names; request bodies are never logged.
   - Model loaders reject HTTP/HTTPS/file URLs and enforce bundle-size limits. Remote downloads require explicit opt-in.
   - Ingress middleware enforces JSON content type and a 64 KiB body limit; violation responses use the standard error envelope.

4. **Documentation & Governance**
   - Dataset and golden-set artefacts are versioned via `services-py/safety_gate_service/data/manifest.json`. Labeling instructions live at `docs/ml/safety_gate_labeling.md`.
   - Operational expectations (warmup, metrics, alerts) are captured here and referenced by the service README and runbooks.

## Consequences
- Deployments must update environment variables for model rollouts; helm charts and Terraform modules require corresponding changes.
- CI should run the golden-set evaluation script and fail on regressions against the published baseline.
- Any new external egress needs an explicit allow-list entry and a security review.
- Future model upgrades must refresh the manifest checksum and document changes in this ADR.
