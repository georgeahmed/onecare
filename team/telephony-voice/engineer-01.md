Engineer: Telephony/Voice 01

Role: Telephony/Voice Engineer (IVR/ASR)
Stack: Cloud IVR, ASR, Node.js

Responsibilities
- Ingest call audio → transcript; intent classification; parity with portal; emergency transfer.

Initial Tasks
- Build telephony ingest adapters; emit telephony.call.transcribed and intent.classified events.

Start Here
- Algorithm.md: 2.3 Telephony Parity sequence
- Schemas: schemas/telephony/*.json

Status: planned
Progress: 0%

Dependencies
- ml/engineer-03 (ASR)
- backend/engineer-01 (Orchestrator ingress)
- telephony-voice/engineer-02 (Routing)

Tasks
- [ ] TV-01.1 — Telephony ingest adapter skeleton (capture audio/metadata)
- [ ] TV-01.2 — ASR client integration; map output to CallTranscribed schema
- [ ] TV-01.3 — Publish telephony.call.transcribed envelope (EventEnvelope)
- [ ] TV-01.4 — Emergency transfer stub with config flags (enabled/disabled)
 - [ ] TV-01.5 — Contract-first: telephony schemas + validators (codegen; compiled validators; contract tests)
 - [ ] TV-01.6 — ASR client guardrails (timeout/retry/jitter/circuit breaker; SSRF allowlist; TLS; correlationId)
 - [ ] TV-01.7 — Streaming ingest → Object Store (chunking, Binary/DocumentReference linking; TTL retention; PHI-safe)
 - [ ] TV-01.8 — Language detection + diarization options (config-driven; privacy-preserving)
 - [ ] TV-01.9 — Intent classification integration + publish intent.classified (idempotent; validators)
 - [ ] TV-01.10 — Idempotency & dedupe (per-call; suppress duplicate publishes; metrics)
 - [ ] TV-01.11 — Backpressure & rate limits (concurrency caps; per-caller/practice token-bucket; 429/503 mapping)
 - [ ] TV-01.12 — Observability (correlationId propagation; ingest/chunk/asr latency histograms; spans; PHI-safe logs)
 - [ ] TV-01.13 — Health/readiness + graceful shutdown (ASR/Object Store checks; drain in-flight streams)
 - [ ] TV-01.14 — Fault injection tests (timeouts, CB-open, network blips; deterministic, offline)
 - [ ] TV-01.15 — Privacy & retention policy (audio retention, secure erase; minimal payloads; redaction)
 - [ ] TV-01.16 — Sandbox playback harness (fixtures for transcripts/intents; offline CI)
