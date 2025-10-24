import logging

import pytest
from fastapi.testclient import TestClient

from safety_gate_service.analyzer import fallback_metrics
from safety_gate_service.main import app as safety_app, reset_models_for_testing
from scribe_service.main import app as scribe_app
from security_utils import safety_headers, set_safety_auth_env


@pytest.fixture
def safety_environment(monkeypatch):
    monkeypatch.delenv("SAFETY_GATE_TIMEOUT_MS", raising=False)
    monkeypatch.delenv("FEATURE_LOGGING", raising=False)
    set_safety_auth_env(monkeypatch)
    fallback_metrics.reset()
    reset_models_for_testing()
    yield
    fallback_metrics.reset()
    reset_models_for_testing()


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


def test_pipeline_spans_flow(monkeypatch, caplog, safety_environment):
    monkeypatch.setenv("OTEL_ENABLED", "1")
    caplog.set_level(logging.INFO, logger="onecare.otel")
    correlation_id = "otel-span-test"

    with TestClient(safety_app) as client:
        response = client.post(
            "/analyze",
            headers=safety_headers(correlation_id=correlation_id),
            json={
                "practiceId": "p-span",
                "patient": {"id": "pt-1"},
                "narrative": "shortness of breath",
                "channel": "web",
            },
        )
        assert response.status_code == 200

    messages = [record.getMessage() for record in caplog.records]
    assert any("span.start name=safety_gate.ner.analyze" in msg for msg in messages)
    assert any("span.finish name=safety_gate.classifier.classify" in msg for msg in messages)
    assert any("span.finish name=safety_gate.decision.evaluate" in msg for msg in messages)
    assert any("correlation_id': 'otel-span-test" in msg for msg in messages)
