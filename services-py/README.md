Python ML Services

Purpose
- Host ML-heavy components (safety gate, scribe) using Python stack (FastAPI + Pydantic).

Structure
- common/contracts: shared Pydantic models "generated" from schemas
- safety_gate_service: urgent diversion analysis
- scribe_service: audio ingestion and drafting

Run (example)
- uvicorn safety_gate_service.main:app --reload --port 8081
- uvicorn scribe_service.main:app --reload --port 8082

