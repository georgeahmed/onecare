import math

import pytest

from safety_gate_service.classifier import (
    EmergencyClassifier,
    IdentityCalibration,
    TemperatureCalibration,
)


def _thresholds_config() -> dict:
    return {
        "defaults": {"emergency_confidence": 0.7},
        "models": {
            "stub-v1": {
                "emergency_confidence": 0.68,
                "thresholds": {
                    "control": 0.7,
                    "experiment": 0.95,
                },
            }
        },
    }


def test_classifier_honors_threshold_per_variant():
    text = "Patient reports severe chest pain and shortness of breath."
    thresholds = _thresholds_config()

    control_classifier = EmergencyClassifier(
        thresholds=thresholds, model_version="stub-v1", model_variant="control"
    )
    experiment_classifier = EmergencyClassifier(
        thresholds=thresholds, model_version="stub-v1", model_variant="experiment"
    )

    control_result = control_classifier.classify(text)
    experiment_result = experiment_classifier.classify(text)

    assert control_result["threshold"] == pytest.approx(0.7)
    assert control_result["is_emergency"] is True
    assert experiment_result["threshold"] == pytest.approx(0.95)
    assert experiment_result["is_emergency"] is False
    assert control_result["model_version"] == experiment_result["model_version"] == "stub-v1"


def test_classifier_non_emergency_text_below_threshold():
    classifier = EmergencyClassifier(thresholds=_thresholds_config(), model_version="stub-v1")
    result = classifier.classify("Mild rash improving with home care.")

    assert result["prob_emergency"] < result["threshold"]
    assert result["is_emergency"] is False


def test_default_calibration_is_identity():
    text = "Patient reports severe chest pain and shortness of breath."
    base = EmergencyClassifier(thresholds=_thresholds_config())
    identity = EmergencyClassifier(thresholds=_thresholds_config(), calibrator=IdentityCalibration())

    base_prob = base.classify(text)["prob_emergency"]
    identity_prob = identity.classify(text)["prob_emergency"]

    assert math.isclose(base_prob, identity_prob, rel_tol=1e-9)


def test_temperature_calibration_can_adjust_probability():
    text = "Patient reports severe chest pain and shortness of breath."
    base = EmergencyClassifier(thresholds=_thresholds_config())
    cooled = EmergencyClassifier(
        thresholds=_thresholds_config(), calibrator=TemperatureCalibration(temperature=3.0)
    )

    base_prob = base.classify(text)["prob_emergency"]
    cooled_prob = cooled.classify(text)["prob_emergency"]

    assert cooled_prob < base_prob
