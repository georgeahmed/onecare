"""Golden set evaluation utilities for the Safety Gate service."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


@dataclass
class GoldenRecord:
    record_id: str
    expected_decision: str
    expected_red_flags: frozenset[str]
    model_decision: str
    model_red_flags: frozenset[str]

    @classmethod
    def from_json(cls, payload: dict[str, object]) -> "GoldenRecord":
        def _ensure_list(value: object) -> Sequence[str]:
            if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
                return [str(item) for item in value]
            return []

        return cls(
            record_id=str(payload["id"]),
            expected_decision=str(payload["expectedDecision"]),
            expected_red_flags=frozenset(_ensure_list(payload.get("expectedRedFlags"))),
            model_decision=str(payload.get("modelDecision", "")),
            model_red_flags=frozenset(_ensure_list(payload.get("modelRedFlags"))),
        )


def load_golden_set(path: Path) -> list[GoldenRecord]:
    records: list[GoldenRecord] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            records.append(GoldenRecord.from_json(payload))
    return records


@dataclass
class EvaluationMetrics:
    decision_accuracy: float
    precision: float
    recall: float
    f1: float


def evaluate(records: Iterable[GoldenRecord]) -> EvaluationMetrics:
    decisions_total = 0
    decisions_correct = 0

    tp = fp = fn = 0

    for record in records:
        decisions_total += 1
        if record.model_decision == record.expected_decision:
            decisions_correct += 1

        expected = record.expected_red_flags
        predicted = record.model_red_flags

        tp += len(expected & predicted)
        fp += len(predicted - expected)
        fn += len(expected - predicted)

    decision_accuracy = decisions_correct / decisions_total if decisions_total else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) else 0.0

    return EvaluationMetrics(
        decision_accuracy=decision_accuracy,
        precision=precision,
        recall=recall,
        f1=f1,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Safety Gate golden set outputs")
    parser.add_argument(
        "--golden-set",
        default=Path(__file__).with_name("golden_set.v1.jsonl"),
        type=Path,
        help="Path to the golden set JSONL file",
    )
    args = parser.parse_args()

    records = load_golden_set(args.golden_set)
    metrics = evaluate(records)
    print(
        json.dumps(
            {
                "decisionAccuracy": round(metrics.decision_accuracy, 4),
                "precision": round(metrics.precision, 4),
                "recall": round(metrics.recall, 4),
                "f1": round(metrics.f1, 4),
                "count": len(records),
            },
            indent=2,
        )
    )


if __name__ == "__main__":  # pragma: no cover - CLI helper
    main()
