from fastapi.testclient import TestClient
import pytest

from safety_gate_service.main import app as safety_app
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
        assert response.json() == {"status": "ok"}


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
            assert response.json() == {"status": "ready"}

        with TestClient(service_app) as client:
            client.app.state.model_ready = False
            response = client.get("/ready")
            assert response.status_code == 503
            assert response.json() == {"detail": {"status": "not_ready"}}
    finally:
        service_app.state.model_ready = original_state
