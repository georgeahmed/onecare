Python ML Services

Purpose
- Host ML-heavy components (safety gate, scribe) using Python stack (FastAPI + Pydantic).

Python Version
- Requires Python 3.10 – 3.12 (3.11 recommended). Pydantic v1 is not yet compatible with Python 3.13+.

Structure
- common/contracts: shared Pydantic models "generated" from schemas
- safety_gate_service: urgent diversion analysis
- scribe_service: audio ingestion and drafting

Run (example)
- uvicorn safety_gate_service.main:app --reload --port 8081
- uvicorn scribe_service.main:app --reload --port 8082

Developer Workflow
- Tests: `./run-tests.sh` (creates/uses `.venv`, installs `[dev]` extras, then runs `pytest`)
