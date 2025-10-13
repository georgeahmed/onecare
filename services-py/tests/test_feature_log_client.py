from __future__ import annotations

from typing import Any

import pytest
from services_py.safety_gate_service import main
from urllib import error as urllib_error


def _payload(correlation: str | None = "corr-1") -> dict[str, Any]:
    return {
        "source": "safety",
        "entityId": "entity-1",
        "patientId": "patient-1",
        "correlationId": correlation,
        "features": {},
        "metadata": {},
    }


def test_feature_log_endpoint_invalid_scheme(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_LOGGING", "1")
    monkeypatch.setenv("FEATURE_LOG_ENDPOINT", "ftp://invalid")
    called = False

    def fake_urlopen(*args: Any, **kwargs: Any) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(main.urllib_request, "urlopen", fake_urlopen)
    main._emit_feature_log(_payload())
    assert called is False


def test_feature_log_retries_on_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_LOGGING", "1")
    monkeypatch.setenv("FEATURE_LOG_ENDPOINT", "https://telemetry.example/log")
    monkeypatch.setenv("FEATURE_LOG_RETRY_ATTEMPTS", "3")
    monkeypatch.setattr(main, "_feature_log_sleep", lambda _: None)
    monkeypatch.setattr(main.random, "random", lambda: 0.0)

    call_count = 0

    def fake_urlopen(*args: Any, **kwargs: Any) -> None:
        nonlocal call_count
        call_count += 1
        raise urllib_error.URLError("boom")

    monkeypatch.setattr(main.urllib_request, "urlopen", fake_urlopen)
    main._emit_feature_log(_payload())
    assert call_count == 3


def test_feature_log_auth_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_LOGGING", "1")
    monkeypatch.setenv("FEATURE_LOG_ENDPOINT", "https://telemetry.example/log")
    monkeypatch.setenv("FEATURE_LOG_BEARER_TOKEN", "secret-token")
    captured_headers: dict[str, str] | None = None

    def fake_urlopen(request_obj: main.urllib_request.Request, **_: Any) -> None:
        nonlocal captured_headers
        captured_headers = dict(request_obj.headers)

    monkeypatch.setattr(main.urllib_request, "urlopen", fake_urlopen)
    main._emit_feature_log(_payload("corr-xyz"))
    assert captured_headers is not None
    assert captured_headers.get("authorization") == "Bearer secret-token"
    assert captured_headers.get("content-type") == "application/json"
    assert captured_headers.get("x-correlation-id") == "corr-xyz"
