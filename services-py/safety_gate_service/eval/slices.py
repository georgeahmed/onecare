from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

from .metrics import MetricSummary, compute_confusion_matrix, compute_metric_summary


@dataclass
class SliceResult:
    name: str
    summary: MetricSummary
    support: int


def compute_slice_metrics(
    *,
    true_labels: Sequence[str],
    predicted_labels: Sequence[str],
    slice_keys: Sequence[str],
) -> list[SliceResult]:
    if not (len(true_labels) == len(predicted_labels) == len(slice_keys)):
        raise ValueError("All inputs must have equal length")
    slices: dict[str, list[int]] = {}
    for idx, key in enumerate(slice_keys):
        slices.setdefault(key, []).append(idx)
    results: list[SliceResult] = []
    for key, indices in sorted(slices.items()):
        subset_true = [true_labels[i] for i in indices]
        subset_pred = [predicted_labels[i] for i in indices]
        matrix = compute_confusion_matrix(subset_true, subset_pred)
        summary = compute_metric_summary(matrix)
        results.append(SliceResult(name=key, summary=summary, support=len(indices)))
    return results
