"""Evaluation utilities for Safety Gate models."""

from .metrics import (
    ConfusionMatrix,
    MetricSummary,
    compute_confusion_matrix,
    compute_metric_summary,
    compute_pr_curve,
    compute_roc_curve,
    expected_calibration_error,
)
from .calibration import TemperatureScalingResult, calibrate_temperature
from .slices import SliceResult, compute_slice_metrics

__all__ = [
    "ConfusionMatrix",
    "MetricSummary",
    "compute_confusion_matrix",
    "compute_metric_summary",
    "compute_pr_curve",
    "compute_roc_curve",
    "expected_calibration_error",
    "TemperatureScalingResult",
    "calibrate_temperature",
    "SliceResult",
    "compute_slice_metrics",
]
