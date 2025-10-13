from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from common.contracts.models import ScribeAudio
from common.otel import instrument_fastapi
from .asr_runner import load_model, transcribe as run_transcription
from .audio_store import create_audio_store
from .quality import evaluate_quality
from .llm_client import SummaryLLM
from .postprocess import highlight_uncertainty


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Initialize transcription resources before serving traffic.
    app.state.model_ready = False
    app.state.asr_model = load_model()
    app.state.audio_store = create_audio_store()
    app.state.llm_client = None
    app.state.model_ready = True
    try:
        yield
    finally:
        app.state.model_ready = False
        app.state.asr_model = None
        app.state.audio_store = None
        app.state.llm_client = None


app = FastAPI(title="Scribe Service", version="0.1.0", lifespan=lifespan)
instrument_fastapi(app)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict[str, str]:
    if getattr(app.state, "model_ready", False):
        return {"status": "ready"}
    raise HTTPException(status_code=503, detail={"status": "not_ready"})


class TranscriptQuality(BaseModel):
    lowConfidence: bool
    silenceDetected: bool
    notes: list[str] = Field(default_factory=list)


class Transcript(BaseModel):
    text: str
    quality: Optional[TranscriptQuality] = None


class Draft(BaseModel):
    summary: str
    approved: bool = True


@app.post("/transcribe", response_model=Transcript)
def transcribe(audio: ScribeAudio) -> Transcript:
    model = getattr(app.state, "asr_model", None)
    if model is None:
        model = load_model()

    audio_payload = {
        "url": audio.audioUrl,
        "audioUrl": audio.audioUrl,
        "encounterId": audio.encounterId,
    }
    if audio.diarization is not None:
        audio_payload["diarization"] = audio.diarization

    result = run_transcription(audio_payload, model=model)
    store = getattr(app.state, "audio_store", None)
    if store is not None:
        store.record(encounter_id=audio.encounterId, audio_url=audio.audioUrl)
    quality = evaluate_quality(
        result.text,
        chunk_texts=[chunk.text for chunk in result.chunks],
    )
    return Transcript(
        text=result.text,
        quality=TranscriptQuality(
            lowConfidence=quality.low_confidence,
            silenceDetected=quality.silence_detected,
            notes=list(quality.notes),
        ),
    )


@app.post("/draft", response_model=Draft)
def draft(transcript: Transcript) -> Draft:
    client = _get_llm_client()
    max_tokens = _resolve_max_summary_tokens()
    summary_text = client.summarize(
        transcript.text,
        max_tokens=max_tokens,
    )
    postprocessed = highlight_uncertainty(summary_text, max_tokens=max_tokens)
    approved = not _require_clinician_approval()
    return Draft(summary=postprocessed, approved=approved)


def _get_llm_client() -> SummaryLLM:
    client = getattr(app.state, "llm_client", None)
    if client is None:
        try:
            client = SummaryLLM.from_env()
        except Exception as exc:  # noqa: BLE001 - surface to HTTP layer
            raise HTTPException(
                status_code=503,
                detail={"status": "llm_unavailable", "reason": "missing_or_invalid_configuration"},
            ) from exc
        app.state.llm_client = client
    return client


def _resolve_max_summary_tokens() -> int:
    candidates = [
        os.getenv("SUMMARY_MAX_TOKENS"),
        os.getenv("SCRIBE_SUMMARY_MAX_TOKENS"),
    ]
    for value in candidates:
        if not value:
            continue
        try:
            parsed = int(str(value).strip())
            if parsed > 0:
                return parsed
        except ValueError:
            continue
    return 512


def _require_clinician_approval() -> bool:
    candidates = [
        os.getenv("REQUIRE_CLINICIAN_APPROVAL"),
        os.getenv("SCRIBE_REQUIRE_CLINICIAN_APPROVAL"),
    ]
    for value in candidates:
        if value is None:
            continue
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    # default true to align with config/nhs_gp_defaults.yaml
    return True
