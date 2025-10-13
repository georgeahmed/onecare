Engineer: ML 02

Role: ML Engineer (Acuity Model)
Stack: XGBoost/LightGBM

Responsibilities
- Acuity model over encoded symptoms + patient context.

Initial Tasks
- Feature engineering; calibration; expose predict + predict_proba.

Start Here
- Algorithm.md: 2.2 Safety Gate (acuity), 3) Triage scoring weights
- Config: config/nhs_gp_defaults.yaml (triage.score_weights)

Status: planned
Progress: 0%

Dependencies
- backend/engineer-03 (Triage)
- data-engineering/engineer-02 (Feature store)
- mlops/engineer-02 (Monitoring)

Tasks
- [ ] ML-02.1 — Define feature schema + encoding utilities
- [ ] ML-02.2 — Train baseline acuity model (XGBoost/LightGBM)
- [ ] ML-02.3 — Calibrate thresholds (Platt/temperature) for Emergency
- [ ] ML-02.4 — FastAPI /predict and /predict_proba endpoints
- [ ] ML-02.5 — Save/load model artifact with versioning
- [ ] ML-02.6 — Unit tests with fixtures for predictable outputs
