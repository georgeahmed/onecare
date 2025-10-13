import os

import pytest

from scribe_service.postprocess import highlight_uncertainty, should_highlight_uncertainty
from scribe_service.token_utils import rough_token_count


def test_highlight_uncertainty_flags_terms(monkeypatch):
    monkeypatch.setenv("UNCERTAINTY_HIGHLIGHT", "true")
    summary = "Patient is maybe experiencing dizziness and possibly dehydration."

    highlighted = highlight_uncertainty(summary, max_tokens=30)

    assert "[UNCERTAIN]maybe[/UNCERTAIN]" in highlighted
    assert "[UNCERTAIN]possibly[/UNCERTAIN]" in highlighted
    assert rough_token_count(summary) <= 30


def test_highlight_uncertainty_disabled(monkeypatch):
    monkeypatch.setenv("UNCERTAINTY_HIGHLIGHT", "0")
    summary = "Patient is maybe experiencing dizziness."

    highlighted = highlight_uncertainty(summary, max_tokens=5)

    assert highlighted == summary


def test_should_highlight_defaults_to_true(monkeypatch):
    monkeypatch.delenv("UNCERTAINTY_HIGHLIGHT", raising=False)
    monkeypatch.delenv("SCRIBE_UNCERTAINTY_HIGHLIGHT", raising=False)

    assert should_highlight_uncertainty() is True
