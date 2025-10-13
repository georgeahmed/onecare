from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence, Tuple


@dataclass
class TemperatureCalibrator:
    temperature: float
    threshold: float

    def probability(self, score: float) -> float:
        scaled = score / max(self.temperature, 1e-6)
        return 1.0 / (1.0 + math.exp(-scaled))

    def is_emergency(self, score: float) -> bool:
        return self.probability(score) >= self.threshold


def fit_temperature_threshold(
    scores: Sequence[float],
    labels: Sequence[int],
    positive_label: int = 2,
    temperature_grid: Iterable[float] | None = None,
) -> TemperatureCalibrator:
    if not scores:
        return TemperatureCalibrator(temperature=1.0, threshold=0.5)

    if temperature_grid is None:
        temperature_grid = [round(x, 2) for x in frange(0.5, 5.0, 0.25)]

    best_temp = 1.0
    best_loss = float("inf")

    for temp in temperature_grid:
        nll = _negative_log_likelihood(scores, labels, temp, positive_label)
        if nll < best_loss:
            best_loss = nll
            best_temp = temp

    probabilities = [_sigmoid(score / max(best_temp, 1e-6)) for score in scores]
    threshold = _optimal_threshold(probabilities, labels, positive_label)

    return TemperatureCalibrator(temperature=best_temp, threshold=threshold)


def frange(start: float, stop: float, step: float) -> Iterable[float]:
    value = start
    while value <= stop + 1e-9:
        yield value
        value += step


def _sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-value))


def _negative_log_likelihood(scores: Sequence[float], labels: Sequence[int], temperature: float, positive: int) -> float:
    loss = 0.0
    for score, label in zip(scores, labels):
        prob = _sigmoid(score / max(temperature, 1e-6))
        prob = min(max(prob, 1e-6), 1 - 1e-6)
        if label == positive:
            loss -= math.log(prob)
        else:
            loss -= math.log(1 - prob)
    return loss / max(len(scores), 1)


def _optimal_threshold(probs: Sequence[float], labels: Sequence[int], positive: int) -> float:
    candidates = sorted(set(probs))
    best_threshold = 0.5
    best_score = -1.0

    for candidate in candidates:
        tp = sum(1 for p, y in zip(probs, labels) if p >= candidate and y == positive)
        fp = sum(1 for p, y in zip(probs, labels) if p >= candidate and y != positive)
        fn = sum(1 for p, y in zip(probs, labels) if p < candidate and y == positive)

        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        if precision == 0 and recall == 0:
            f1 = 0.0
        else:
            f1 = 2 * precision * recall / (precision + recall)

        if f1 > best_score:
            best_score = f1
            best_threshold = candidate

    return float(best_threshold)
