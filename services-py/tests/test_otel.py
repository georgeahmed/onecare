import logging

import pytest
from fastapi.testclient import TestClient

from safety_gate_service.main import app as safety_app
from scribe_service.main import app as scribe_app


@pytest.mark.parametrize(
    "service_app, path",
    [(safety_app, "/health"), (scribe_app, "/health")],
    ids=["safety-gate", "scribe"],
)
def test_instrumentation_disabled_by_default(service_app, path, caplog, monkeypatch):
    monkeypatch.delenv("OTEL_ENABLED", raising=False)
    caplog.set_level(logging.INFO, logger="onecare.otel")
    with TestClient(service_app) as client:
        response = client.get(path)
        assert response.status_code == 200

    assert not any("http.server.duration_ms" in record.getMessage() for record in caplog.records)


def test_instrumentation_emits_logs_when_enabled(monkeypatch, caplog):
    monkeypatch.setenv("OTEL_ENABLED", "1")
    caplog.set_level(logging.INFO, logger="onecare.otel")

    with TestClient(safety_app) as client:
        response = client.get("/health")
        assert response.status_code == 200

    metrics = [record.getMessage() for record in caplog.records if "http.server.duration_ms" in record.getMessage()]
    assert metrics, "expected duration metric log when OTEL_ENABLED=1"
