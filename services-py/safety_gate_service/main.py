from fastapi import FastAPI, HTTPException
from common.contracts.models import PortalSubmission, SafetyDecision
from common.otel import instrument_fastapi

app = FastAPI(title="Safety Gate Service", version="0.1.0")
instrument_fastapi(app)
app.state.model_ready = True


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
