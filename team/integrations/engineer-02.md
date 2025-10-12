Engineer: Integrations 02

Role: Integration Engineer (GP Connect)
Stack: GP Connect, TypeScript

Responsibilities
- Booking via GP Connect; eligibility and conflict handling.
 - Enhanced Access (PCN) booking windows and templates.

Initial Tasks
- Build GP Connect client; integrate with booking state machine.

Start Here
- Algorithm.md: 4) Booking (Local, PCN EA, GP Connect)
- Config: config/nhs_gp_defaults.yaml (enhanced_access_windows)

Status: in-progress
Progress: 11%

Dependencies
- backend/engineer-04 (Booking service)
- devops-sre/engineer-01 (Network/IAM)

Tasks
- [x] IN-02.1a — GP Connect client foundation (HTTPS, mTLS/OAuth, env/config)
- [ ] IN-02.1b — Resilience: timeout/retry/jitter, connection pooling, circuit breaker
- [ ] IN-02.1c — Security: TLS verification, optional cert pinning, SSRF allowlist
- [x] IN-02.2a — Slot search mapping (paging, filters, TZ-safe windows)
- [ ] IN-02.2b — Contract validators (search request/response schemas; codegen + compiled validators)
- [ ] IN-02.3a — Appointment create idempotency + conflict handling (natural key; exactly-once write)
- [ ] IN-02.3b — Conflict policies + fallback (reselect/backoff; safe retry)
- [ ] IN-02.4 — Enhanced Access constraints (windows, slot types, fairness floors; config-driven)
- [ ] IN-02.5 — FHIR write-back links for created appointments (Task update; references; audit)
- [ ] IN-02.6 — Observability: latency histograms, error/conflict rates, spans; correlation propagation
- [ ] IN-02.7 — Backpressure & rate limits (adapter-level caps; 429/503 mapping)
- [ ] IN-02.8 — Health/readiness (client reachability, auth validity; graceful shutdown)
- [ ] IN-02.9 — Fault injection tests (timeouts/CB open/conflicts; deterministic http mocks; no network)
- [ ] IN-02.10 — Documentation & ADRs (client design, conflict semantics, security posture)
- [ ] IN-02.11 — Privacy/PII minimization (PHI-safe logs; minimal event payloads)
- [ ] IN-02.12 — API version/content negotiation (GP Connect headers; Accept/Prefer)
- [ ] IN-02.13 — Credential/cert rotation readiness (OAuth/mTLS refresh; hot-reload)
- [ ] IN-02.14 — Performance baselines (search/create p50/p95; pooling/keep-alive budgets)
- [ ] IN-02.15 — Sandbox playback harness (deterministic fixtures; provider response emulation)
