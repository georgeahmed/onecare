from fastapi import FastAPI
from pydantic import BaseModel
from common.contracts.models import PortalSubmission, SafetyDecision

app = FastAPI(title="Safety Gate Service", version="0.1.0")


@app.post("/analyze", response_model=SafetyDecision)
def analyze(submission: PortalSubmission) -> SafetyDecision:
    # Placeholder: always proceed, unless a trivial red-flag is present.
    narrative = (submission.narrative or "").lower()
    red_flags = ["chest pain", "unresponsive", "severe bleeding"]
    if any(flag in narrative for flag in red_flags):
        return SafetyDecision(outcome="DIVERTED", reason="red_flag")
    return SafetyDecision(outcome="SAFE_TO_CONTINUE")

