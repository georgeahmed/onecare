import asyncio
import types

from fastapi.testclient import TestClient

from safety_gate_service.main import ConcurrencyLimiter, app
from security_utils import safety_headers, set_safety_auth_env


def test_concurrency_limiter_queue_rejects_when_full():
    limiter = ConcurrencyLimiter(max_concurrency=1, max_queue=0, wait_timeout_ms=100)

    first = asyncio.run(limiter.acquire())
    assert first is None
    second = asyncio.run(limiter.acquire())
    assert second == "queue"
    limiter.release()


def test_concurrency_limiter_times_out_waiters():
    limiter = ConcurrencyLimiter(max_concurrency=1, max_queue=1, wait_timeout_ms=10)

    first = asyncio.run(limiter.acquire())
    assert first is None
    result_holder = asyncio.run(limiter.acquire())
    assert result_holder == "timeout"
    limiter.release()


def test_concurrency_limiter_zero_timeout():
    limiter = ConcurrencyLimiter(max_concurrency=1, max_queue=0, wait_timeout_ms=0)

    first = asyncio.run(limiter.acquire())
    assert first is None
    second = asyncio.run(limiter.acquire())
    assert second in {"timeout", "queue"}
    limiter.release()


def test_analyze_returns_429_when_limiter_reports_queue(monkeypatch):
    set_safety_auth_env(monkeypatch)
    monkeypatch.setenv("SAFETY_GATE_ENABLE_BATCHING", "0")
    with TestClient(app) as client:
        limiter = ConcurrencyLimiter(max_concurrency=1, max_queue=0, wait_timeout_ms=10)

        async def fake_acquire(self):  # type: ignore[no-untyped-def]
            return "queue"

        def fake_release(self):  # type: ignore[no-untyped-def]
            raise AssertionError("release should not be called when limiter rejects")

        limiter.acquire = types.MethodType(fake_acquire, limiter)
        limiter.release = types.MethodType(fake_release, limiter)
        client.app.state.concurrency_limiter = limiter
        response = client.post(
            "/analyze",
            headers=safety_headers(),
            json={
                "practiceId": "p1",
                "patient": {"id": "pt-1"},
                "narrative": "payload",
                "channel": "web",
            },
        )
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "too_many_requests"


def test_analyze_returns_503_when_limiter_times_out(monkeypatch):
    set_safety_auth_env(monkeypatch)
    monkeypatch.setenv("SAFETY_GATE_ENABLE_BATCHING", "0")
    with TestClient(app) as client:
        limiter = ConcurrencyLimiter(max_concurrency=1, max_queue=1, wait_timeout_ms=10)

        async def fake_acquire(self):  # type: ignore[no-untyped-def]
            return "timeout"

        def fake_release(self):  # type: ignore[no-untyped-def]
            raise AssertionError("release should not be called when limiter rejects")

        limiter.acquire = types.MethodType(fake_acquire, limiter)
        limiter.release = types.MethodType(fake_release, limiter)
        client.app.state.concurrency_limiter = limiter
        response = client.post(
            "/analyze",
            headers=safety_headers(),
            json={
                "practiceId": "p1",
                "patient": {"id": "pt-1"},
                "narrative": "payload",
                "channel": "web",
            },
        )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"
