import pytest
from fastapi.testclient import TestClient

from safety_gate_service.main import app, reset_models_for_testing


@pytest.fixture(autouse=True)
def reset_classifier_fixture(monkeypatch):
    monkeypatch.delenv("SAFETY_GATE_EMERGENCY_CONFIDENCE", raising=False)
    monkeypatch.delenv("SAFETY_GATE_MODEL_VERSION", raising=False)
    monkeypatch.delenv("SAFETY_GATE_MODEL_VARIANT", raising=False)
    monkeypatch.delenv("SAFETY_GATE_CLASSIFIER_MODE", raising=False)
    monkeypatch.delenv("SAFETY_GATE_ACUITY_MODE", raising=False)
    monkeypatch.delenv("SAFETY_GATE_ACUITY_MODEL_PATH", raising=False)
    reset_models_for_testing()
    yield
    reset_models_for_testing()


def test_analyze_proceed():
    client = TestClient(app)
    resp = client.post(
        "/analyze",
        json={
            "practiceId": "p1",
            "patient": {"id": "x"},
            "narrative": "mild headache",
            "channel": "web",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "SAFE_TO_CONTINUE"


def test_analyze_divert():
    client = TestClient(app)
    resp = client.post(
        "/analyze",
        json={
            "practiceId": "p1",
            "patient": {"id": "x"},
            "narrative": "I have chest pain",
            "channel": "web",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "DIVERTED"
    assert resp.json()["reason"] == "red_flag:chest_pain"


def test_analyze_classifier_emergency_without_red_flag():
    client = TestClient(app)
    resp = client.post(
        "/analyze",
        json={
            "practiceId": "p1",
            "patient": {"id": "x"},
            "narrative": "Patient reports they are suicidal and thinking about dying tonight.",
            "channel": "web",
        },
    )
    body = resp.json()
    assert resp.status_code == 200
    assert body["outcome"] == "DIVERTED"
    assert body.get("reason") == "classifier:probability"
