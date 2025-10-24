import math

from safety_gate_service.eval.calibration import apply_temperature, calibrate_temperature
from safety_gate_service.eval.metrics import (
    compute_confusion_matrix,
    compute_metric_summary,
    compute_pr_curve,
    compute_roc_curve,
    expected_calibration_error,
)
from safety_gate_service.eval.slices import compute_slice_metrics


def test_confusion_matrix_and_metrics():
    truth = ["POS", "NEG", "POS", "NEG", "POS"]
    preds = ["POS", "NEG", "NEG", "NEG", "POS"]
    matrix = compute_confusion_matrix(truth, preds)
    summary = compute_metric_summary(matrix)
    assert matrix.matrix == [[2, 1], [0, 2]]
    assert summary.precision["POS"] == 1.0
    assert math.isclose(summary.recall["POS"], 2 / 3, rel_tol=1e-6)


def test_pr_and_roc_curves():
    labels = [1, 0, 1, 0]
    scores = [0.9, 0.8, 0.2, 0.1]
    roc = compute_roc_curve(labels, scores)
    pr = compute_pr_curve(labels, scores)
    assert roc[0] == (0.0, 0.0)
    assert roc[-1] == (1.0, 1.0)
    assert pr[0][1] >= pr[-1][1]


def test_expected_calibration_error_and_temperature():
    labels = [1, 0, 1, 0]
    probs = [0.9, 0.6, 0.2, 0.1]
    baseline = expected_calibration_error(labels, probs)
    result = calibrate_temperature(labels, probs)
    assert result.ece_before == baseline
    assert result.ece_after <= baseline
    calibrated = apply_temperature(probs, result.temperature)
    assert 0 <= min(calibrated) <= 1


def test_slice_metrics():
    truth = ["POS", "NEG", "POS", "NEG"]
    preds = ["POS", "NEG", "NEG", "NEG"]
    slices = ["web", "web", "ivr", "ivr"]
    results = compute_slice_metrics(true_labels=truth, predicted_labels=preds, slice_keys=slices)
    summary_by_slice = {item.name: item.summary for item in results}
    assert math.isclose(summary_by_slice["web"].precision["POS"], 1.0, rel_tol=1e-6)
    assert len(results) == 2
