import logging
import sys

import pytest

try:  # pragma: no cover - ensure compatibility if Pydantic v2 is installed
    import pydantic.v1 as _pydantic_v1  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover - native Pydantic v1
    import pydantic  # type: ignore[no-redefined-reassignment]
else:  # pragma: no cover - remap pydantic to v1 compatibility layer
    sys.modules["pydantic"] = _pydantic_v1
    import pydantic  # type: ignore[no-redefined-reassignment]

from safety_gate_service import main as safety_main


def test_logger_redacts_basic_pii(caplog):
    caplog.set_level(logging.INFO, logger="safety_gate_service.main")
    caplog.clear()

    safety_main.LOGGER.info(
        "user_email=%s contact=%s code=%s",
        "alice@example.com",
        "+1 555-123-4567",
        "1234567",
    )

    assert caplog.records, "expected at least one log record"
    message = caplog.records[-1].getMessage()
    assert "[REDACTED_EMAIL]" in message
    assert "[REDACTED_PHONE]" in message
    assert "[REDACTED_NUMBER]" in message


def test_sanitize_payload_masks_names():
    sanitized = safety_main._sanitize_payload({"patientName": "Alice Johnson"})
    assert sanitized["patientName"] == "[REDACTED_NAME]"


def test_sampling_disabled_in_production(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "prod")
    try:
        assert not safety_main._should_sample_request_logs({"log_sample_rate": 1})
    finally:
        monkeypatch.delenv("ENVIRONMENT", raising=False)


@pytest.mark.parametrize("draw,expected", [(0.1, True), (0.9, False)])
def test_sampling_policy_respects_override(monkeypatch, draw, expected):
    monkeypatch.setenv("ENVIRONMENT", "dev")
    monkeypatch.setenv("SAFETY_GATE_LOG_SAMPLE_RATE", "0.5")
    monkeypatch.setattr(safety_main.random, "random", lambda: draw)
    try:
        assert safety_main._should_sample_request_logs({}, sample=None) is expected
    finally:
        monkeypatch.delenv("SAFETY_GATE_LOG_SAMPLE_RATE", raising=False)
        monkeypatch.delenv("ENVIRONMENT", raising=False)
