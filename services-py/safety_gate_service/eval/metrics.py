from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence


@dataclass
class ConfusionMatrix:
    labels: Sequence[str]
    matrix: list[list[int]]


@dataclass
class MetricSummary:
    precision: Mapping[str, float]
    recall: Mapping[str, float]
    f1: Mapping[str, float]


def _ensure_labels(labels: Sequence[str]) -> list[str]:
    seen = []
    for label in labels:
        if label not in seen:
            seen.append(label)
    return seen


def compute_confusion_matrix(
    true_labels: Sequence[str],
    predicted_labels: Sequence[str],
    *,
    labels: Sequence[str] | None = None,
) -> ConfusionMatrix:
    if len(true_labels) != len(predicted_labels):
        raise ValueError("true_labels and predicted_labels must have equal length")
    if labels is None:
        labels = _ensure_labels(list(dict.fromkeys(list(true_labels) + list(predicted_labels))))
    index = {label: idx for idx, label in enumerate(labels)}
    size = len(labels)
    matrix = [[0 for _ in range(size)] for _ in range(size)]
    for truth, pred in zip(true_labels, predicted_labels):
        if truth not in index or pred not in index:
            continue
        matrix[index[truth]][index[pred]] += 1
    return ConfusionMatrix(labels=list(labels), matrix=matrix)


def _safe_divide(num: float, denom: float) -> float:
    if denom == 0:
        return 0.0
    return num / denom


def compute_metric_summary(matrix: ConfusionMatrix) -> MetricSummary:
    size = len(matrix.labels)
    precision: dict[str, float] = {}
    recall: dict[str, float] = {}
    f1: dict[str, float] = {}
    for idx, label in enumerate(matrix.labels):
        true_positive = matrix.matrix[idx][idx]
        false_positive = sum(matrix.matrix[row][idx] for row in range(size) if row != idx)
        false_negative = sum(matrix.matrix[idx][col] for col in range(size) if col != idx)
        prec = _safe_divide(true_positive, true_positive + false_positive)
        rec = _safe_divide(true_positive, true_positive + false_negative)
        f_score = _safe_divide(2 * prec * rec, prec + rec) if prec and rec else 0.0
        precision[label] = prec
        recall[label] = rec
        f1[label] = f_score
    return MetricSummary(precision=precision, recall=recall, f1=f1)


def compute_roc_curve(true_labels: Sequence[int], scores: Sequence[float]) -> list[tuple[float, float]]:
    if len(true_labels) != len(scores):
        raise ValueError("true_labels and scores length mismatch")
    paired = sorted(zip(scores, true_labels), reverse=True)
    positives = sum(true_labels)
    negatives = len(true_labels) - positives
    if positives == 0 or negatives == 0:
        return [(0.0, 0.0), (1.0, 1.0)]
    tpr = fpr = 0.0
    roc_points = [(0.0, 0.0)]
    prev_score = None
    for score, label in paired:
        if prev_score is not None and score != prev_score:
            roc_points.append((fpr, tpr))
        if label:
            tpr += 1 / positives
        else:
            fpr += 1 / negatives
        prev_score = score
    roc_points.append((1.0, 1.0))
    return roc_points


def compute_pr_curve(true_labels: Sequence[int], scores: Sequence[float]) -> list[tuple[float, float]]:
    if len(true_labels) != len(scores):
        raise ValueError("true_labels and scores length mismatch")
    paired = sorted(zip(scores, true_labels), reverse=True)
    tp = fp = 0
    total_positive = sum(true_labels)
    if total_positive == 0:
        return [(0.0, 0.0)]
    points: list[tuple[float, float]] = []
    for idx, (_, label) in enumerate(paired, 1):
        if label:
            tp += 1
        else:
            fp += 1
        precision = tp / (tp + fp)
        recall = tp / total_positive
        points.append((recall, precision))
    return points


def expected_calibration_error(
    true_labels: Sequence[int],
    scores: Sequence[float],
    *,
    num_bins: int = 10,
) -> float:
    if len(true_labels) != len(scores):
        raise ValueError("true_labels and scores length mismatch")
    bins = [0 for _ in range(num_bins)]
    bin_totals = [0.0 for _ in range(num_bins)]
    bin_correct = [0.0 for _ in range(num_bins)]
    for score, label in zip(scores, true_labels):
        bounded_score = min(max(score, 0.0), 1.0)
        bin_index = min(num_bins - 1, int(bounded_score * num_bins))
        bins[bin_index] += 1
        bin_totals[bin_index] += bounded_score
        bin_correct[bin_index] += label
    total = len(scores)
    if total == 0:
        return 0.0
    ece = 0.0
    for count, total_score, correct in zip(bins, bin_totals, bin_correct):
        if count == 0:
            continue
        avg_confidence = total_score / count
        avg_accuracy = correct / count
        ece += (count / total) * abs(avg_confidence - avg_accuracy)
    return ece
