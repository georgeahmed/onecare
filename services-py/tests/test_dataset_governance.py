from pathlib import Path

from safety_gate_service.data.eval_golden import EvaluationMetrics, evaluate, load_golden_set

DATA_DIR = Path(__file__).resolve().parents[1] / "safety_gate_service" / "data"

def test_golden_set_evaluation_metrics():
    records = load_golden_set(DATA_DIR / "golden_set.v1.jsonl")
    metrics = evaluate(records)
    assert metrics == EvaluationMetrics(decision_accuracy=1.0, precision=1.0, recall=1.0, f1=1.0)
    assert len(records) >= 3
