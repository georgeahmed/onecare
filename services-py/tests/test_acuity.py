import pytest

from safety_gate_service.acuity import AcuityModel


def test_stub_acuity_raises_probability_on_red_flags(monkeypatch):
    monkeypatch.setenv("SAFETY_GATE_ACUITY_MODE", "stub")
    model = AcuityModel()
    result = model.predict(
        narrative="Patient reports severe chest pain and feels unresponsive at times.",
        nlp_results={
            "symptom_mentions": [{"name": "chest pain", "confidence": 0.92}],
            "red_flag_hits": ["chest pain"],
        },
        classifier_result={"prob_emergency": 0.4},
    )

    assert 0 <= result["prob_emergency"] <= 1
    assert result["prob_emergency"] >= 0.8
    assert result["level"] == "emergency"
    assert result["model_version"] == "stub-v1"


def test_stub_acuity_remains_low_for_routine_case(monkeypatch):
    monkeypatch.setenv("SAFETY_GATE_ACUITY_MODE", "stub")
    model = AcuityModel()
    result = model.predict(
        narrative="Patient reports mild rash improving over two days.",
        nlp_results={"symptom_mentions": [{"name": "mild rash", "confidence": 0.3}]},
        classifier_result={"prob_emergency": 0.1},
    )

    assert result["prob_emergency"] < 0.6
    assert result["level"] in {"routine", "urgent"}
