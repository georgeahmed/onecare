import pytest
from fastapi.testclient import TestClient

from safety_gate_service.analyzer import fallback_metrics
from safety_gate_service.main import app, reset_models_for_testing
from safety_gate_service.metrics import metrics_tracker
from security_utils import safety_headers, set_safety_auth_env


prometheus_client = pytest.importorskip("prometheus_client")
_ = prometheus_client  # avoid unused-import lint noise


@pytest.fixture(autouse=True)
def reset_state(monkeypatch):
    monkeypatch.delenv("SAFETY_GATE_TIMEOUT_MS", raising=False)
    monkeypatch.delenv("FEATURE_LOGGING", raising=False)
    set_safety_auth_env(monkeypatch)
    fallback_metrics.reset()
    reset_models_for_testing()
    metrics_tracker.reset()
    yield
    fallback_metrics.reset()
    reset_models_for_testing()
    metrics_tracker.reset()


def test_metrics_endpoint_reports_request_counters():
    client = TestClient(app)
    correlation_id = "metrics-request-correlation"

    analyze_response = client.post(
        "/analyze",
        headers=safety_headers(correlation_id=correlation_id),
        json={
            "practiceId": "practice-123",
            "patient": {"id": "patient-1"},
            "narrative": "persistent cough",
            "channel": "web",
        },
    )
    assert analyze_response.status_code == 200

    metrics_response = client.get("/metrics", headers={"x-correlation-id": correlation_id})
    assert metrics_response.status_code == 200
    assert metrics_response.headers.get("x-correlation-id") == correlation_id

    body = metrics_response.text
    assert "safety_gate_requests_total" in body
    assert 'endpoint="analyze",status="success"' in body
    assert "safety_gate_request_latency_seconds_bucket" in body
