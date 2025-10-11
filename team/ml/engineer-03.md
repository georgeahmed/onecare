Engineer: ML 03

Role: ML Engineer (Scribe ASR)
Stack: Whisper, diarization

Responsibilities
- ASR pipeline with diarization; robust to clinic noise.

Initial Tasks
- Integrate Whisper; diarization; chunking; expose /transcribe.

Start Here
- Algorithm.md: 7) Ambient Scribe & Summarisation
- Config: config/nhs_gp_defaults.yaml (ambient_scribe)

Status: planned
Progress: 0%

Dependencies
- scribe service (backend team)
- mlops/engineer-01 (Deploy)

Tasks
- [ ] ML-03.1 — Whisper model download + runner stub
- [ ] ML-03.2 — Diarization pipeline integration
- [ ] ML-03.3 — Chunking/long audio handling + transcript concat
- [ ] ML-03.4 — Map to schemas + FastAPI /transcribe endpoint
- [ ] ML-03.5 — Quality heuristics (confidence, silence) + unit tests
- [ ] ML-03.6 — Audio retention controls
