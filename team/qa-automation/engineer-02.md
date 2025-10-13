Engineer: QA Automation 02

Role: QA Automation Engineer (Performance/Telephony)
Stack: k6/Locust, Telephony test tools

Responsibilities
- Load/perf testing; IVR/ASR flow validation.

Initial Tasks
- Baseline perf tests; telephony flow checks; SLAs.

Start Here
- Algorithm.md: SLOs under 12) Observability; Telephony Parity sequence
- Tools: choose k6/Locust; integrate with CI artifacts

Status: in-progress
Progress: 29%

Dependencies
- telephony-voice team (IVR/ASR)
- devops-sre team (load env)

Platform Checklist (pre-flight)
- Load test environment prepared; rate limits set to safe testing thresholds.
- k6/Locust installed in CI runners; baseline scripts ready; SLO thresholds defined.
- Stable endpoints for telephony parity tests; no PII in logs/artifacts.

Tasks
- [x] QA-02.1 — k6 baseline load for /safety-check (latency/throughput)
- [x] QA-02.2 — Triage flow load test (publish triage.input → tasks.created)
- [ ] QA-02.3 — Booking flow load test (search/create)
- [ ] QA-02.4 — Telephony parity flow checks (IVR → ASR → intent)
- [ ] QA-02.5 — CI integration with SLO thresholds + artifacts
- [ ] QA-02.6 — Alert SLO tests
- [ ] QA-02.5 — CI integration with SLO thresholds + artifacts
