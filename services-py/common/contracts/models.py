"""
GENERATED from schemas/ (v0.1). Replace via codegen.
"""
from __future__ import annotations
from typing import Any, Dict, List, Optional, Union, Literal
from pydantic import BaseModel, Field


class EventEnvelope(BaseModel):
    id: str
    topic: str
    timestamp: str
    payload: Any
    correlationId: Optional[str] = None


class PortalSubmissionPatient(BaseModel):
    id: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    dob: Optional[str] = Field(default=None)
    locale: Optional[str] = Field(default=None, pattern=r"^[a-z]{2}(?:-[A-Z]{2})?$")


class AttachmentRef(BaseModel):
    contentType: str = Field(
        ...,
        min_length=3,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$",
    )
    url: str = Field(..., min_length=1, max_length=2048, pattern=r"^https://")


class PortalSubmission(BaseModel):
    practiceId: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    patient: PortalSubmissionPatient
    narrative: str = Field(..., max_length=500_000)
    attachments: Optional[List[AttachmentRef]] = Field(default=None, max_length=10)
    channel: Literal["web", "ivr"]


class TriageInput(BaseModel):
    patientId: str
    narrative: str
    features: Optional[Dict[str, Union[str, float, bool, None]]] = None


class BookingSearchRequest(BaseModel):
    serviceType: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    windowStart: str = Field(..., min_length=1)
    windowEnd: str = Field(..., min_length=1)
    location: Optional[str] = Field(default=None, min_length=2, max_length=64, pattern=r"^[-A-Za-z0-9._:\s]+$")


class PharmacySlot(BaseModel):
    start: str
    end: str


class PharmacyReferral(BaseModel):
    patientId: str
    condition: str
    pharmacyOrg: str
    slot: Optional[PharmacySlot] = None


class ScribeAudio(BaseModel):
    encounterId: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    audioUrl: str = Field(..., min_length=1, max_length=2048, pattern=r"^(https|s3)://")
    contentType: str = Field(
        ...,
        min_length=3,
        max_length=128,
        pattern=r"^audio/[A-Za-z0-9!#$&^_.+-]{1,63}$",
    )
    diarization: Optional[bool] = None


class SafetyDecision(BaseModel):
    outcome: Literal["DIVERTED", "SAFE_TO_CONTINUE"]
    reason: Optional[str] = None
