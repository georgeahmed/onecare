from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, List

from .calibration import calibrate_temperature
from .metrics import (
    compute_confusion_matrix,
    compute_metric_summary,
    compute_pr_curve,
    compute_roc_curve,
    expected_calibration_error,
)
from .slices import compute_slice_metrics


@dataclass
class EvalRecord:
    record_id: str
    expected_decision: str
    model_decision: str
    probability: float
    slice_key: str | None
    red_flags_expected: frozenset[str]
    red_flags_model: frozenset[str]

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> "EvalRecord":
        def as_set(field: str) -> frozenset[str]:
            value = payload.get(field, [])
            if isinstance(value, list):
                return frozenset(str(item) for item in value)
            return frozenset()

        return cls(
            record_id=str(payload.get("id")),
            expected_decision=str(payload.get("expectedDecision")),
            model_decision=str(payload.get("modelDecision", "")),
            probability=float(payload.get("modelProbEmergency", 0.0)),
            slice_key=str(payload.get("slice")) if payload.get("slice") is not None else None,
            red_flags_expected=as_set("expectedRedFlags"),
            red_flags_model=as_set("modelRedFlags"),
        )


def load_records(path: Path) -> list[EvalRecord]:
    records: list[EvalRecord] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            data = json.loads(line)
            records.append(EvalRecord.from_json(data))
    records.sort(key=lambda record: record.record_id)
    return records


def decision_metrics(records: Iterable[EvalRecord]) -> dict[str, Any]:
    truth = [record.expected_decision for record in records]
    preds = [record.model_decision for record in records]
    matrix = compute_confusion_matrix(truth, preds)
    summary = compute_metric_summary(matrix)
    accuracy = sum(1 for t, p in zip(truth, preds) if t == p) / len(truth) if truth else 0.0
    return {
        "labels": matrix.labels,
        "confusion": matrix.matrix,
        "precision": summary.precision,
        "recall": summary.recall,
        "f1": summary.f1,
        "accuracy": accuracy,
    }


def emergency_binary_vectors(records: Iterable[EvalRecord]) -> tuple[list[int], list[float]]:
    truth = [1 if record.expected_decision.upper() == "DIVERTED" else 0 for record in records]
    scores = [record.probability for record in records]
    return truth, scores


def slice_metrics(records: List[EvalRecord]) -> list[dict[str, Any]]:
    if not any(record.slice_key for record in records):
        return []
    truth = [record.expected_decision for record in records]
    preds = [record.model_decision for record in records]
    keys = [record.slice_key or "unknown" for record in records]
    slices = compute_slice_metrics(true_labels=truth, predicted_labels=preds, slice_keys=keys)
    return [
        {
            "slice": result.name,
            "support": result.support,
            "precision": result.summary.precision,
            "recall": result.summary.recall,
            "f1": result.summary.f1,
        }
        for result in slices
    ]


def run_evaluation(records: list[EvalRecord]) -> dict[str, Any]:
    metrics = decision_metrics(records)
    truth, scores = emergency_binary_vectors(records)
    roc = compute_roc_curve(truth, scores)
    pr = compute_pr_curve(truth, scores)
    ece = expected_calibration_error(truth, scores)
    calibration = calibrate_temperature(truth, scores)
    slices = slice_metrics(records)
    return {
        "decisions": metrics,
        "roc": roc,
        "pr": pr,
        "ece": ece,
        "temperature": {
            "chosen": calibration.temperature,
            "before": calibration.ece_before,
            "after": calibration.ece_after,
        },
        "slices": slices,
        "count": len(records),
    }


def enforce_thresholds(results: dict[str, Any], accuracy_threshold: float, recall_threshold: float) -> None:
    accuracy = results["decisions"]["accuracy"]
    recall_map = results["decisions"]["recall"]
    diverted_recall = recall_map.get("DIVERTED") or recall_map.get("diverted") or 0.0
    failures: list[str] = []
    if accuracy < accuracy_threshold:
        failures.append(f"decision accuracy {accuracy:.3f} < {accuracy_threshold:.3f}")
    if diverted_recall < recall_threshold:
        failures.append(f"DIVERTED recall {diverted_recall:.3f} < {recall_threshold:.3f}")
    if failures:
        raise SystemExit("; ".join(failures))


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Safety Gate golden set")
    parser.add_argument("--golden-set", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "golden_set.v1.jsonl")
    parser.add_argument("--output", type=Path, default=Path("artifacts/eval/safety_gate_metrics.json"))
    parser.add_argument("--accuracy-threshold", type=float, default=0.95)
    parser.add_argument("--recall-threshold", type=float, default=0.90)
    args = parser.parse_args()

    records = load_records(args.golden_set)
    if not records:
        raise SystemExit("no records found in golden set")
    results = run_evaluation(records)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2, sort_keys=True))
    print(f"Saved evaluation metrics to {args.output}")
    enforce_thresholds(results, args.accuracy_threshold, args.recall_threshold)


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    main()
