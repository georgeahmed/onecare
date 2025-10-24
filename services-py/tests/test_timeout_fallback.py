import time

import pytest
from fastapi.testclient import TestClient

from safety_gate_service.analyzer import fallback_metrics
from safety_gate_service.main import app, reset_models_for_testing
from security_utils import safety_headers, set_safety_auth_env


@pytest.fixture(autouse=True)
def reset_models(monkeypatch):
    monkeypatch.delenv("SAFETY_GATE_TIMEOUT_MS", raising=False)
    monkeypatch.delenv("SAFETY_GATE_ACUITY_MODE", raising=False)
    monkeypatch.delenv("SAFETY_GATE_ACUITY_MODEL_PATH", raising=False)
    set_safety_auth_env(monkeypatch)
    fallback_metrics.reset()
    reset_models_for_testing()
    yield
    fallback_metrics.reset()
    reset_models_for_testing()


def test_timeout_triggers_rules_fallback(monkeypatch):
    def slow_analyze(self, text: str):
        time.sleep(0.05)
        return {
            "symptoms": [],
            "severity": [],
            "temporal": [],
            "context_entities": [],
            "symptom_mentions": [],
        }

    monkeypatch.setattr("safety_gate_service.ner.SafetyNER.analyze", slow_analyze, raising=False)
    monkeypatch.setattr("safety_gate_service.language.detect", lambda _: "en")

    with TestClient(app) as client:
        decision_config = getattr(app.state, "decision_config")
        decision_config["timeout_ms"] = 5
        decision_config["fallback"] = "rules"

        response = client.post(
            "/analyze",
            headers=safety_headers(),
            json={
                "practiceId": "p1",
                "patient": {"id": "x"},
                "narrative": "Patient reports chest pain after exercise.",
                "channel": "web",
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["outcome"] == "DIVERTED"
    assert body["reason"] == "fallback:red_flag"

    metrics = fallback_metrics.snapshot()
    assert metrics.get("timeout_rules") == 1
