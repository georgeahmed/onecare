from common.calibration import TemperatureCalibrator, fit_temperature_threshold


def test_temperature_calibration_probability():
    calibrator = TemperatureCalibrator(temperature=2.0, threshold=0.7)
    prob = calibrator.probability(1.5)
    assert 0 < prob < 1
    assert calibrator.is_emergency(2.0) is True
    assert calibrator.is_emergency(0.1) is False


def test_fit_temperature_threshold_finds_reasonable_values():
    scores = [2.0, 1.5, 0.5, -0.5, -1.0]
    labels = [2, 2, 1, 0, 0]

    calibrator = fit_temperature_threshold(scores, labels, positive_label=2)

    assert calibrator.temperature > 0
    assert 0 <= calibrator.threshold <= 1
    assert calibrator.is_emergency(2.0) is True
    assert calibrator.is_emergency(-1.0) is False
