import pytest

from safety_gate_service.decision import decide, DecisionResult


def _base_config(**overrides):
    config = {
        "red_flag_threshold": 0.65,
        "red_flag_set": ["chest pain", "shortness of breath", "severe bleeding"],
        "emergency_confidence": 0.74,
        "acuity_threshold_emergency": 0.8,
    }
    config.update(overrides)
    return config


def test_decide_diverts_on_red_flag_mentions():
    nlp_results = {
        "symptom_mentions": [
            {"name": "chest pain", "confidence": 0.9},
            {"name": "mild headache", "confidence": 0.2},
        ]
    }

    result = decide(
        nlp_results=nlp_results,
        classifier_result={"prob_emergency": 0.2, "threshold": 0.8},
        patient={},
        config=_base_config(),
    )

    assert isinstance(result, DecisionResult)
    assert result.outcome == "DIVERTED"
    assert result.rationale["reason"].startswith("red_flag:")
    assert "chest_pain" in result.rationale["signals"]["red_flags"]


def test_decide_uses_classifier_when_red_flags_absent():
    result = decide(
        nlp_results={"symptom_mentions": []},
        classifier_result={"prob_emergency": 0.82, "threshold": 0.8, "model_version": "stub-v1"},
        patient={},
        config=_base_config(),
    )

    assert result.outcome == "DIVERTED"
    assert result.rationale["reason"] == "classifier:probability"
    assert result.rationale["signals"]["model_version"] == "stub-v1"
    assert result.rationale["signals"]["probability"] == pytest.approx(0.82)


def test_decide_honors_classifier_threshold():
    result = decide(
        nlp_results={"symptom_mentions": []},
        classifier_result={"prob_emergency": 0.6, "threshold": 0.8},
        patient={},
        config=_base_config(),
    )

    assert result.outcome == "SAFE_TO_CONTINUE"
    assert result.rationale["reason"] == "safe"


def test_decide_diverts_on_acuity_level():
    patient = {"acuity": {"level": "Emergency"}}
    result = decide(
        nlp_results={"symptom_mentions": []},
        classifier_result={"prob_emergency": 0.4, "threshold": 0.8},
        patient=patient,
        config=_base_config(),
    )

    assert result.outcome == "DIVERTED"
    assert result.rationale["reason"] == "acuity:level"


def test_decide_diverts_on_acuity_probability():
    patient = {"acuity": {"prob_emergency": 0.86}}
    result = decide(
        nlp_results={"symptom_mentions": []},
        classifier_result={"prob_emergency": 0.4, "threshold": 0.8},
        patient=patient,
        config=_base_config(),
    )

    assert result.outcome == "DIVERTED"
    assert result.rationale["reason"] == "acuity:probability"


def test_decide_returns_safe_when_no_triggers():
    patient = {"acuity": {"prob_emergency": 0.2}}
    result = decide(
        nlp_results={"symptom_mentions": []},
        classifier_result={"prob_emergency": 0.3, "threshold": 0.8},
        patient=patient,
        config=_base_config(),
    )

    assert result.outcome == "SAFE_TO_CONTINUE"
    assert result.rationale["reason"] == "safe"


def test_decide_handles_precomputed_red_flags():
    nlp_results = {
        "symptom_mentions": [],
        "red_flag_hits": ["Severe Bleeding"],
    }
    result = decide(
        nlp_results=nlp_results,
        classifier_result={"prob_emergency": 0.1, "threshold": 0.9},
        patient={},
        config=_base_config(),
    )

    assert result.outcome == "DIVERTED"
    assert result.rationale["reason"] == "red_flag:severe_bleeding"


def test_decide_respects_red_flag_threshold():
    config = _base_config(red_flag_threshold=0.8)
    nlp_results = {
        "symptom_mentions": [
            {"name": "chest pain", "confidence": 0.6},
        ]
    }

    result = decide(
        nlp_results=nlp_results,
        classifier_result={"prob_emergency": 0.2, "threshold": 0.9},
        patient={},
        config=config,
    )

    assert result.outcome == "SAFE_TO_CONTINUE"
    assert result.rationale["reason"] == "safe"
