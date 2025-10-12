import pytest
from fastapi.testclient import TestClient

from safety_gate_service.main import app
from safety_gate_service.predict import load_model_bundle


@pytest.fixture(autouse=True)
def reset_model_cache(monkeypatch):
    monkeypatch.delenv("SAFETY_GATE_ACUITY_MODEL_PATH", raising=False)
    monkeypatch.delenv("SAFETY_GATE_ACUITY_META_PATH", raising=False)
    load_model_bundle.cache_clear()
    yield
    load_model_bundle.cache_clear()


def test_predict_returns_emergency_for_high_risk_sample():
    client = TestClient(app)
    correlation_id = "predict-endpoint-test"

    response = client.post(
        "/predict",
        headers={"x-correlation-id": correlation_id},
        json={
            "symptomMentions": [
                {"name": "Severe chest pain", "confidence": 0.9},
                {"name": "Shortness of breath"},
            ],
            "patient": {"ageYears": 67, "comorbidities": {"cardiac": True, "diabetes": True}},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["level"] == "emergency"
    assert body["probEmergency"] == pytest.approx(1.0)
    assert response.headers["x-correlation-id"] == correlation_id
    assert body["modelVersion"]


def test_predict_proba_distribution_is_deterministic():
    client = TestClient(app)
    response = client.post(
        "/predict_proba",
        json={
            "symptomMentions": [{"name": "Mild headache"}],
            "patient": {"ageYears": 29, "comorbidities": {}},
        },
    )

    assert response.status_code == 200
    body = response.json()
    probabilities = body["probabilities"]
    assert set(probabilities) == {"routine", "urgent", "emergency"}
    total = sum(probabilities.values())
    assert total == pytest.approx(1.0, rel=1e-6, abs=1e-9)
    assert probabilities["routine"] > probabilities["urgent"]
    assert probabilities["emergency"] < 1e-6
