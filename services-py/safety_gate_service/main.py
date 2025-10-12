from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from threading import Lock
from typing import Optional

from fastapi import FastAPI, HTTPException
from common.contracts.models import PortalSubmission, SafetyDecision
from common.otel import instrument_fastapi
from .classifier import EmergencyClassifier


LOGGER = logging.getLogger("safety_gate_service.main")
_CLASSIFIER: Optional[EmergencyClassifier] = None
_CLASSIFIER_LOCK = Lock()


def get_classifier(force_reload: bool = False) -> EmergencyClassifier:
    global _CLASSIFIER

    if force_reload:
        with _CLASSIFIER_LOCK:
            LOGGER.debug("Reloading EmergencyClassifier instance (force_reload=True)")
            _CLASSIFIER = EmergencyClassifier()
            return _CLASSIFIER

    if _CLASSIFIER is None:
        with _CLASSIFIER_LOCK:
            if _CLASSIFIER is None:
                LOGGER.debug("Initializing EmergencyClassifier instance")
                _CLASSIFIER = EmergencyClassifier()
    return _CLASSIFIER


def reset_models_for_testing() -> None:
    """Reset cached models so tests can reconfigure env thresholds."""

    global _CLASSIFIER
    with _CLASSIFIER_LOCK:
        _CLASSIFIER = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.model_ready = False
    try:
        app.state.classifier = get_classifier()
    except Exception as exc:  # pragma: no cover - startup failure path
        LOGGER.exception("Failed to initialize EmergencyClassifier: %s", exc)
        raise
    app.state.model_ready = True
    try:
        yield
    finally:
        app.state.model_ready = False
        app.state.classifier = None


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
    narrative_raw = submission.narrative or ""
    narrative_lower = narrative_raw.lower()
    red_flags = ["chest pain", "unresponsive", "severe bleeding"]
    if any(flag in narrative_lower for flag in red_flags):
        return SafetyDecision(outcome="DIVERTED", reason="red_flag")

    classifier = getattr(app.state, "classifier", None) or get_classifier()
    try:
        classification = classifier.classify(narrative_raw)
    except Exception as exc:  # pragma: no cover - runtime fallback
        LOGGER.exception("Emergency classifier failed, defaulting to SAFE_TO_CONTINUE: %s", exc)
        return SafetyDecision(outcome="SAFE_TO_CONTINUE")

    if classification.get("is_emergency"):
        return SafetyDecision(outcome="DIVERTED", reason="emergency_classifier")

    return SafetyDecision(outcome="SAFE_TO_CONTINUE")
