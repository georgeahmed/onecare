from fastapi.testclient import TestClient
import pytest

from safety_gate_service.main import app as safety_app, reset_models_for_testing
from scribe_service.main import app as scribe_app


@pytest.mark.parametrize(
    "service_app",
    [safety_app, scribe_app],
    ids=["safety-gate", "scribe"],
)
def test_health_endpoint_returns_ok(service_app):
    with TestClient(service_app) as client:
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        if service_app is safety_app:
            assert "version" in body
            assert "modelHash" in body
            assert response.headers.get("x-correlation-id")


@pytest.mark.parametrize(
    "service_app",
    [safety_app, scribe_app],
    ids=["safety-gate", "scribe"],
)
def test_ready_endpoint_reflects_model_state(service_app):
    original_state = getattr(service_app.state, "model_ready", False)
    try:
        with TestClient(service_app) as client:
            client.app.state.model_ready = True
            response = client.get("/ready")
            assert response.status_code == 200
            body = response.json()
            assert body["status"] == "ready"
            if service_app is safety_app:
                assert body["version"] == service_app.version
                assert "modelHash" in body
                assert response.headers.get("x-correlation-id")

        with TestClient(service_app) as client:
            client.app.state.model_ready = False
            response = client.get("/ready")
            assert response.status_code == 503
            body = response.json()
            if service_app is safety_app:
                assert body["status"] == "warming"
                assert body["version"] == service_app.version
                assert response.headers.get("x-correlation-id")
            else:
                assert body.get("detail", {}).get("status") == "not_ready"
    finally:
        service_app.state.model_ready = original_state


def test_ready_reports_model_versions(monkeypatch):
    monkeypatch.setenv("SAFETY_GATE_NER_MODE", "stub")
    monkeypatch.setenv("SAFETY_GATE_NER_MODEL", "local-ner-v2")
    monkeypatch.setenv("SAFETY_GATE_CLASSIFIER_MODEL", "local-classifier-v3")
    monkeypatch.setenv("SAFETY_GATE_MODEL_VERSION", "local-classifier-v3")
    reset_models_for_testing()

    with TestClient(safety_app) as client:
        response = client.get("/ready")
        assert response.status_code == 200
        body = response.json()
        assert body["modelHash"]
        assert body["classifierVersion"] == "local-classifier-v3"
        assert body["nerModel"] == "local-ner-v2"

    # Clean up to avoid leaking overrides to other tests
    reset_models_for_testing()
