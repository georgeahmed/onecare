import asyncio
import sys
import types

import pytest

from safety_gate_service.acuity import AcuityModel
from safety_gate_service.classifier import EmergencyClassifier
from safety_gate_service import main as safety_main


def test_batch_processor_groups_requests():
    async def _run() -> None:
        processor = safety_main.BatchProcessor(enabled=True, max_batch_size=2, batch_timeout_ms=50)

        events: list[str] = []

        async def worker(name: str) -> str:
            events.append(f"start:{name}")
            await asyncio.sleep(0)
            events.append(f"done:{name}")
            return name

        async def submit(name: str) -> str:
            return await processor.submit(lambda name=name: worker(name))

        results = await asyncio.gather(submit("a"), submit("b"))

        assert set(results) == {"a", "b"}
        assert processor.last_batch_size == 2
        assert events.count("start:a") == 1 and events.count("start:b") == 1

    asyncio.run(_run())


def test_batch_processor_timeout_flush():
    async def _run() -> None:
        processor = safety_main.BatchProcessor(enabled=True, max_batch_size=10, batch_timeout_ms=5)

        async def immediate() -> int:
            return 42

        result = await processor.submit(immediate)

        assert result == 42
        assert processor.last_batch_size == 1

    asyncio.run(_run())


def test_acuity_memory_budget_enforced(tmp_path, monkeypatch):
    bundle_path = tmp_path / "model.joblib"
    bundle_path.write_bytes(b"x" * 2048)
    env = {
        "SAFETY_GATE_ACUITY_MODEL_PATH": str(bundle_path),
        "SAFETY_GATE_MAX_MODEL_BYTES": "1024",
        "SAFETY_GATE_ACUITY_MODE": "stub",
    }
    joblib_stub = types.SimpleNamespace(load=lambda path: lambda *args, **kwargs: None)
    monkeypatch.setitem(sys.modules, "joblib", joblib_stub)
    model = AcuityModel(env=env)

    with pytest.raises(RuntimeError, match="memory budget"):
        model._load_bundle(str(bundle_path))


def test_classifier_quantization_fallback(monkeypatch):
    env = {
        "SAFETY_GATE_ENABLE_QUANTIZATION": "1",
        "SAFETY_GATE_DEVICE": "cpu",
        "SAFETY_GATE_MAX_MODEL_BYTES": "0",
    }
    classifier = EmergencyClassifier(env=env)

    torch_stub = types.ModuleType("torch")
    torch_stub.qint8 = object()
    torch_stub.nn = types.SimpleNamespace(Linear=object())
    torch_stub.quantization = types.SimpleNamespace(quantize_dynamic=lambda model, layers, dtype: "quantized")

    monkeypatch.setitem(sys.modules, "torch", torch_stub)

    sentinel = object()
    result = classifier._maybe_quantize_model(sentinel)

    assert result == "quantized"
