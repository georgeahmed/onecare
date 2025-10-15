import pytest
from fastapi.testclient import TestClient

from safety_gate_service.analyzer import fallback_metrics
from safety_gate_service.main import app, reset_models_for_testing
from security_utils import safety_headers, set_safety_auth_env


@pytest.fixture(autouse=True)
def reset_models(monkeypatch):
    monkeypatch.delenv("SAFETY_GATE_TIMEOUT_MS", raising=False)
    monkeypatch.delenv("FEATURE_LOGGING", raising=False)
    set_safety_auth_env(monkeypatch)
    fallback_metrics.reset()
    reset_models_for_testing()
    yield
    fallback_metrics.reset()
    reset_models_for_testing()


def test_analyze_success_echoes_correlation_header():
    client = TestClient(app)
    correlation_id = "unit-test-correlation"

    response = client.post(
        "/analyze",
        headers=safety_headers(correlation_id=correlation_id),
        json={
            "practiceId": "p1",
            "patient": {"id": "x"},
            "narrative": "mild headache",
            "channel": "web",
        },
    )

    assert response.status_code == 200
    assert response.headers["x-correlation-id"] == correlation_id
    assert response.json()["outcome"] in {"SAFE_TO_CONTINUE", "DIVERTED"}


def test_analyze_invalid_payload_returns_error_envelope():
    client = TestClient(app)
    correlation_id = "invalid-test"

    response = client.post(
        "/analyze",
        headers=safety_headers(correlation_id=correlation_id),
        json={
            "practiceId": "p1",
            "narrative": "missing patient",  # patient field omitted to trigger validation error
            "channel": "web",
        },
    )

    assert response.status_code == 400
    body = response.json()
    assert response.headers["x-correlation-id"] == correlation_id
    assert body["error"]["code"] == "invalid_input"
    assert body["error"]["correlationId"] == correlation_id
    assert body["error"]["message"] == "Invalid request payload"
    assert isinstance(body["error"].get("details", {}).get("errors"), list)
