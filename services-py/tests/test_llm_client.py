import os

import pytest

from scribe_service.llm_client import SummaryLLM


def test_summary_llm_from_env_reads_primary_vars(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_API_ENDPOINT", "https://example.com/llm")

    client = SummaryLLM.from_env()

    assert client.model_name == "gpt-4o-mini"
    assert client.api_key == "test-key"
    assert client.endpoint == "https://example.com/llm"


def test_summary_llm_from_env_falls_back_to_scribe(monkeypatch):
    monkeypatch.delenv("LLM_MODEL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_ENDPOINT", raising=False)
    monkeypatch.setenv("SCRIBE_LLM_MODEL", "scribe-model")
    monkeypatch.setenv("SCRIBE_LLM_API_KEY", "scribe-key")
    monkeypatch.setenv("SCRIBE_LLM_ENDPOINT", "https://scribe.example.com/llm")

    client = SummaryLLM.from_env()

    assert client.model_name == "scribe-model"
    assert client.api_key == "scribe-key"
    assert client.endpoint == "https://scribe.example.com/llm"


def test_summary_llm_requires_api_key(monkeypatch):
    monkeypatch.delenv("LLM_MODEL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_ENDPOINT", raising=False)
    monkeypatch.delenv("SCRIBE_LLM_MODEL", raising=False)
    monkeypatch.delenv("SCRIBE_LLM_API_KEY", raising=False)
    monkeypatch.delenv("SCRIBE_LLM_ENDPOINT", raising=False)

    with pytest.raises(RuntimeError):
        SummaryLLM.from_env()


def test_summarize_returns_deterministic_stub(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "gpt-4o")
    monkeypatch.setenv("LLM_API_KEY", "key")
    client = SummaryLLM.from_env()

    summary = client.summarize(
        "This is a sample transcript with several words.",
        max_tokens=20,
        encounter_id="enc-42",
        patient_name="Alice",
    )

    assert summary.startswith("[summary:gpt-4o:tokens<=20]")
    assert "Encounter: enc-42" in summary
