Engineer: Telephony/Voice 02

Role: Telephony/Voice Engineer (Routing)
Stack: Cloud IVR, NLU

Responsibilities
- Intent classifier integration; callback windows offering by priority.

Initial Tasks
- Integrate classifier; map intents to triage inputs; IVR prompts.

Start Here
- Algorithm.md: 2.3 Telephony Parity, callback windows
- Config: config/nhs_gp_defaults.yaml (callback_windows_by_priority)

Status: in-progress
Progress: 20%

Dependencies
- telephony-voice/engineer-01 (ASR ingest)
- backend/engineer-03 (Triage)
- frontend/engineer-02 (Callback UX)

Tasks
- [ ] TV-02.1 — Intent classifier client skeleton + env (endpoint/keys)
- [ ] TV-02.2 — Map intents → triage input and publish telephony.intent.classified
- [ ] TV-02.3 — Callback window offering logic using config (by priority)
- [x] TV-02.4 — IVR prompts and language options (i18n, config-driven)
- [ ] TV-02.5 — Emergency IVR handoff end‑to‑end stub
