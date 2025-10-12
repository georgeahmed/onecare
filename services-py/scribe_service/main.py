from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from common.contracts.models import ScribeAudio
from common.otel import instrument_fastapi


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Initialize transcription resources before serving traffic.
    app.state.model_ready = False
    app.state.model_ready = True  # Replace with actual initialization when available.
    try:
        yield
    finally:
        app.state.model_ready = False


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


class Transcript(BaseModel):
    text: str


class Draft(BaseModel):
    summary: str


@app.post("/transcribe", response_model=Transcript)
def transcribe(audio: ScribeAudio) -> Transcript:
    # Placeholder: echo a canned transcript
    return Transcript(text=f"[transcript for {audio.audioUrl}]")


@app.post("/draft", response_model=Draft)
def draft(transcript: Transcript) -> Draft:
    # Placeholder: canned draft
    return Draft(summary=f"Summary: {transcript.text}")
