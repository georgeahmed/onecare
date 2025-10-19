from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from .metrics import expected_calibration_error


@dataclass
class TemperatureScalingResult:
    temperature: float
    ece_before: float
    ece_after: float


def _logit(prob: float) -> float:
    prob = min(max(prob, 1e-6), 1 - 1e-6)
    return math.log(prob / (1 - prob))


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def apply_temperature(probabilities: Sequence[float], temperature: float) -> list[float]:
    return [_sigmoid(_logit(p) / temperature) for p in probabilities]


def calibrate_temperature(
    true_labels: Sequence[int],
    probabilities: Sequence[float],
    *,
    temperatures: Sequence[float] | None = None,
) -> TemperatureScalingResult:
    if len(true_labels) != len(probabilities):
        raise ValueError("true_labels and probabilities must have equal length")
    baseline_ece = expected_calibration_error(true_labels, probabilities)
    if not temperatures:
        temperatures = [0.5 + i * 0.1 for i in range(1, 31)]  # 0.6 .. 3.5
    best_temp = 1.0
    best_ece = baseline_ece
    for temp in temperatures:
        calibrated = apply_temperature(probabilities, temp)
        ece = expected_calibration_error(true_labels, calibrated)
        if ece < best_ece:
            best_ece = ece
            best_temp = temp
    return TemperatureScalingResult(
        temperature=best_temp,
        ece_before=baseline_ece,
        ece_after=best_ece,
    )
