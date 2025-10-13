AGENTS.md — services-py/ (Python ML Services)

Scope
- Applies to all Python ML services in `services-py/`.

Practices
- FastAPI + Pydantic models (generated from `schemas/`). Keep endpoints slim.
- Type hints everywhere; format with Black; lint with Ruff.
- Avoid global state; prefer dependency-injected components or FastAPI `Depends`.
- Validate inputs strictly; return explicit error messages without leaking sensitive data.
- Timeouts on outbound calls; never block event loop (async endpoints where appropriate).

Testing
- Use Pytest with FastAPI TestClient; keep tests fast and deterministic.

Packaging
- Keep dependencies minimal; prefer optional extras for dev/test tools.

