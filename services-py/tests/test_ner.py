import pytest

from safety_gate_service.ner import SafetyNER


def test_analyze_stub_outputs_expected_categories(monkeypatch):
    monkeypatch.setenv("SAFETY_GATE_NER_MODE", "stub")
    ner = SafetyNER()

    result = ner.analyze("Patient reports severe chest pain today with difficulty breathing.")

    assert "chest pain" in result["symptoms"]
    assert "difficulty breathing" in result["symptoms"]
    assert "severe" in result["severity"]
    assert "today" in result["temporal"]
    assert not result["context_entities"]


def test_analyze_stub_deduplicates_entities(monkeypatch):
    monkeypatch.setenv("SAFETY_GATE_NER_MODE", "stub")
    ner = SafetyNER()

    result = ner.analyze("Chest pain reported. Chest pain persists.")

    assert result["symptoms"].count("chest pain") == 1


def test_lazy_pipeline_initialization(monkeypatch):
    monkeypatch.setenv("SAFETY_GATE_NER_MODE", "stub")
    ner = SafetyNER()

    assert ner._pipeline is None  # noqa: SLF001 - verifying lazy init
    first = ner.analyze("severe chest pain")  # triggers initialization
    assert ner._pipeline is not None  # noqa: SLF001

    pipeline_ref = ner._pipeline  # noqa: SLF001
    second = ner.analyze("mild chest pain")
    assert ner._pipeline is pipeline_ref  # noqa: SLF001
    assert first["symptoms"]
    assert second["symptoms"]


def test_resolve_device_values(monkeypatch):
    env = {"SAFETY_GATE_NER_MODE": "stub"}
    assert SafetyNER(device="cpu", env=env)._resolve_device() == -1
    assert SafetyNER(device="cuda", env=env)._resolve_device() == 0
    with pytest.raises(ValueError):
        SafetyNER(device="tpu", env=env)._resolve_device()
