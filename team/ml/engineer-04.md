Engineer: ML 04

Role: ML Engineer (Scribe Drafting)
Stack: LLMs, prompt engineering

Responsibilities
- Clinical summary drafting with uncertainty highlighting and approval gates.

Initial Tasks
- LLM selection; prompt templates; expose /draft endpoint.

Start Here
- Algorithm.md: 7) Ambient Scribe (approval, uncertainty)
- Config: config/nhs_gp_defaults.yaml (ambient_scribe settings)

Status: planned
Progress: 0%

Dependencies
- ml/engineer-03 (Transcript input)
- backend scribe write-back (backend team)
- mlops/engineer-01 (Deploy)

Tasks
- [ ] ML-04.1 — LLM client selection + env wiring (model, keys)
- [ ] ML-04.2 — Prompt templates (system + user) for clinical summary
- [ ] ML-04.3 — Uncertainty highlighting post-processing
- [ ] ML-04.4 — Enforce MAX_SUMMARY_TOKENS + truncation strategy
- [ ] ML-04.5 — FastAPI /draft endpoint + Pydantic models
- [ ] ML-04.6 — Approval flag handling (REQUIRE_CLINICIAN_APPROVAL) + tests
