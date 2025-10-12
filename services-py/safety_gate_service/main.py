from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from common.contracts.models import PortalSubmission, SafetyDecision
from common.otel import instrument_fastapi


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Load model artifacts before accepting requests.
    app.state.model_ready = False
    app.state.model_ready = True  # Replace with actual initialization when available.
    try:
        yield
    finally:
        app.state.model_ready = False


app = FastAPI(title="Safety Gate Service", version="0.1.0", lifespan=lifespan)
instrument_fastapi(app)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict[str, str]:
    if getattr(app.state, "model_ready", False):
        return {"status": "ready"}
    raise HTTPException(status_code=503, detail={"status": "not_ready"})


@app.post("/analyze", response_model=SafetyDecision)
def analyze(submission: PortalSubmission) -> SafetyDecision:
    # Placeholder: always proceed, unless a trivial red-flag is present.
    narrative = (submission.narrative or "").lower()
    red_flags = ["chest pain", "unresponsive", "severe bleeding"]
    if any(flag in narrative for flag in red_flags):
        return SafetyDecision(outcome="DIVERTED", reason="red_flag")
    return SafetyDecision(outcome="SAFE_TO_CONTINUE")
