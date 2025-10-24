from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest
from urllib import error as urllib_error

from common.contracts.models import (
    PortalSubmission,
    PortalSubmissionChannel as Channel,
    PortalSubmissionPatient as SubmissionPatient,
)
from safety_gate_service import main
from safety_gate_service.decision import DecisionResult

CONSENT_REFERENCE = "Consent/test"


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
    monkeypatch.setenv("FEATURE_LOG_API_KEY", "feature-key")
    called = False

    def fake_urlopen(*args: Any, **kwargs: Any) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(main.urllib_request, "urlopen", fake_urlopen)
    main._emit_feature_log(_payload(), CONSENT_REFERENCE)
    assert called is False


def test_feature_log_retries_on_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_LOGGING", "1")
    monkeypatch.setenv("FEATURE_LOG_ENDPOINT", "https://telemetry.example/log")
    monkeypatch.setenv("FEATURE_LOG_RETRY_ATTEMPTS", "3")
    monkeypatch.setenv("FEATURE_LOG_API_KEY", "feature-key")
    monkeypatch.setattr(main, "_feature_log_sleep", lambda _: None)
    monkeypatch.setattr(main.random, "random", lambda: 0.0)

    call_count = 0

    def fake_urlopen(*args: Any, **kwargs: Any) -> None:
        nonlocal call_count
        call_count += 1
        raise urllib_error.URLError("boom")

    monkeypatch.setattr(main.urllib_request, "urlopen", fake_urlopen)
    main._emit_feature_log(_payload(), CONSENT_REFERENCE)
    assert call_count == 3


def test_feature_log_auth_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_LOGGING", "1")
    monkeypatch.setenv("FEATURE_LOG_ENDPOINT", "https://telemetry.example/log")
    monkeypatch.setenv("FEATURE_LOG_BEARER_TOKEN", "secret-token")
    monkeypatch.setenv("FEATURE_LOG_API_KEY", "feature-key")
    captured_headers: dict[str, str] | None = None

    def fake_urlopen(request_obj: main.urllib_request.Request, **_: Any) -> None:
        nonlocal captured_headers
        captured_headers = dict(request_obj.headers)

    monkeypatch.setattr(main.urllib_request, "urlopen", fake_urlopen)
    main._emit_feature_log(_payload("corr-xyz"), CONSENT_REFERENCE)
    assert captured_headers is not None
    lowered = {key.lower(): value for key, value in captured_headers.items()}
    assert lowered.get("authorization") == "Bearer secret-token"
    assert lowered.get("content-type") == "application/json"
    assert lowered.get("x-correlation-id") == "corr-xyz"
    assert lowered.get("x-api-key") == "feature-key"
    assert lowered.get("x-auth-scope") == "analytics:feature:write"
    assert lowered.get("x-consent-reference") == CONSENT_REFERENCE


def test_log_safety_features_runs_off_event_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    loop_thread = threading.get_ident()
    observed_threads: set[int] = set()

    def fake_emit(payload: dict[str, Any], consent: str | None) -> None:
        observed_threads.add(threading.get_ident())

    monkeypatch.setattr(main, "_emit_feature_log", fake_emit)

    submission = PortalSubmission(
        practiceId="practice-async",
        patient=SubmissionPatient(id="patient-async"),
        narrative="patient reports mild headache",
        channel=Channel.web,
    )
    classification = {
        "prob_emergency": 0.2,
        "threshold": 0.7,
        "model_version": "stub",
        "is_emergency": False,
    }
    nlp_payload = {"symptom_mentions": [], "redFlagHits": []}
    decision = DecisionResult(outcome="SAFE_TO_CONTINUE", rationale={"reason": "safe", "signals": {}})

    asyncio.run(
        main._log_safety_features(
            submission=submission,
            correlation_id="corr-async",
            classification=classification,
            nlp_payload=nlp_payload,
            decision_result=decision,
            lexical_hits=[],
            consent_reference="Consent/async",
        )
    )

    assert observed_threads, "feature log dispatch did not execute"
    assert all(thread_id != loop_thread for thread_id in observed_threads)
