import asyncio

import pytest
from fastapi.testclient import TestClient

from safety_gate_service.main import app
from security_utils import safety_headers, set_safety_auth_env


@pytest.fixture(autouse=True)
def _configure_env(monkeypatch):
    set_safety_auth_env(monkeypatch)
    monkeypatch.delenv("SAFETY_GATE_MAX_REQUEST_BYTES", raising=False)
    monkeypatch.delenv("SAFETY_GATE_ENABLE_BATCHING", raising=False)
    yield
    monkeypatch.delenv("SAFETY_GATE_MAX_REQUEST_BYTES", raising=False)
    monkeypatch.delenv("SAFETY_GATE_ENABLE_BATCHING", raising=False)


def test_analyze_rejects_non_json_content_type():
    payload = {
        "practiceId": "p1",
        "patient": {"id": "pt-1"},
        "narrative": "sample",
        "channel": "web",
    }

    with TestClient(app) as client:
        headers = safety_headers()
        headers["content-type"] = "text/plain"
        response = client.post(
            "/analyze",
            headers=headers,
            json=payload,
        )

    assert response.status_code == 415
    body = response.json()
    assert body["error"]["code"] == "unsupported_media_type"
    assert response.headers.get("x-correlation-id")


def test_analyze_rejects_payload_over_limit(monkeypatch):
    monkeypatch.setenv("SAFETY_GATE_MAX_REQUEST_BYTES", "10")
    large_narrative = "x" * 20

    with TestClient(app) as client:
        response = client.post(
            "/analyze",
            headers=safety_headers(),
            json={
                "practiceId": "p1",
                "patient": {"id": "pt-1"},
                "narrative": large_narrative,
                "channel": "web",
            },
        )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


def test_unexpected_error_returns_internal_envelope(monkeypatch):
    async def failing_analyze_submission(**_: object):
        raise RuntimeError("boom")

    monkeypatch.setattr(
        "safety_gate_service.main.analyze_submission",
        failing_analyze_submission,
    )

    with TestClient(app) as client:
        response = client.post(
            "/analyze",
            headers=safety_headers(),
            json={
                "practiceId": "p1",
                "patient": {"id": "pt-1"},
                "narrative": "error",
                "channel": "web",
            },
        )

    assert response.status_code == 500
    body = response.json()
    assert body["error"]["code"] == "internal_error"
    assert body["error"]["message"] == "Internal server error"
