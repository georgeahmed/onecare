"""
GENERATED from schemas/ (v0.1). Replace via codegen.
"""
from __future__ import annotations
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel


class EventEnvelope(BaseModel):
    id: str
    topic: str
    timestamp: str
    payload: Any
    correlationId: Optional[str] = None


class PortalSubmissionPatient(BaseModel):
    id: str
    dob: Optional[str] = None
    locale: Optional[str] = None


class AttachmentRef(BaseModel):
    contentType: str
    url: str


class PortalSubmission(BaseModel):
    practiceId: str
    patient: PortalSubmissionPatient
    narrative: str
    attachments: Optional[List[AttachmentRef]] = None
    channel: str  # 'web' | 'ivr'


class TriageInput(BaseModel):
    patientId: str
    narrative: str
    features: Optional[Dict[str, Union[str, float, bool, None]]] = None


class BookingSearchRequest(BaseModel):
    serviceType: str
    windowStart: str
    windowEnd: str
    location: Optional[str] = None


class PharmacySlot(BaseModel):
    start: str
    end: str


class PharmacyReferral(BaseModel):
    patientId: str
    condition: str
    pharmacyOrg: str
    slot: Optional[PharmacySlot | None] = None


class ScribeAudio(BaseModel):
    encounterId: str
    audioUrl: str
    contentType: str
    diarization: Optional[bool] = None


class SafetyDecision(BaseModel):
    outcome: str  # 'DIVERTED' | 'SAFE_TO_CONTINUE'
    reason: Optional[str] = None

