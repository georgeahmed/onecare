# Model Registry & Promotion Workflow

All production models must be tracked with immutable metadata and gated promotion. This guide defines the registry contract, deployment integration, and approval rules.

## Registry Options

We support two paths:

1. **MLflow Tracking Server** (preferred). Store artifacts in S3-compatible storage with metadata (metrics, params, tags).
2. **Lightweight manifest** when external services are unavailable. Example schema:

```json
{
  "modelName": "safety-gate-acuity",
  "version": "2025-10-18",
  "artifactUri": "s3://onecare-ml/models/safety-gate/2025-10-18/model.tar.gz",
  "checksum": "sha256:6de92f2f...",
  "trainingDataVersion": "triage-dataset-2025-09-30",
  "metrics": {
    "rocAuc": 0.948,
    "calibrationSlope": 1.02,
    "shadowAgreement": 0.986
  },
  "thresholds": {
    "divert_threshold": 0.78,
    "fallback_reason": "rules"
  }
}
```

Store manifests under `s3://onecare-ml/registry/<model>/<version>.json` or `packages/feature-registry`.

## Deployment Integration

- Services resolve the desired version via environment variable (e.g., `SAFETY_GATE_ACUITY_MODEL_VERSION`).
- Startup sequence:
  1. Fetch manifest (MLflow REST or JSON).
  2. Download artifact and verify checksum (SHA-256). Abort startup on mismatch.
  3. Emit structured log with `modelVersion`, `trainingDataVersion`, `checksum`.
- Keep the previous version cached locally (`/models/cache`) for instant rollback.

## Promotion Workflow

1. Train & evaluate in staging; record metrics + calibration.
2. Run shadow trial using harness (`services-py/safety_gate_service/shadow_eval.py`) and archive metrics.
3. File promotion request (template in `docs/RUNBOOKS.md`) including:
   - Registry manifest link.
   - Shadow agreement & latency deltas.
   - Risk assessment + rollback plan.
4. Two-person approval (ML owner + MLOps) required before tagging `production`.
5. Update `docs/MLOPS_SLOs.md` if thresholds change.

## Rollback Rules

- Maintain `production-1` and `production-2` tags to identify last known-good artifacts.
- Rollback command:

```bash
mlflow models serve --model-uri "models:/safety-gate-acuity/production-1"
```

Or update the manifest pointer to the previous version and redeploy (blue/green or canary).

## Auditing

- Archive manifests and approval records in `s3://onecare-ml/registry/audit/<YYYY-MM>/`.
- Log promotion events with correlation ID and approver.
- For compliance, export registry entries weekly into the data warehouse.
