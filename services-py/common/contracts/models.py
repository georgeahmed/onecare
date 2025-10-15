"""AUTO-GENERATED from schemas/. DO NOT EDIT MANUALLY."""
from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from pydantic import AnyUrl, BaseModel, confloat, conint, constr, Extra, Field
from typing import Any, Optional, Union

# --- analytics/metric.json ---
class Metric(BaseModel):
    class Config:
        extra = Extra.forbid

    name: str
    value: Union[float, str]
    labels: Optional[dict[str, str]] = None
    timestamp: Optional[datetime] = None

# --- audit/audit-event.json ---
class AuditEvent(BaseModel):
    class Config:
        extra = Extra.forbid

    type: str
    timestamp: datetime
    correlationId: Optional[str] = None
    actor: Optional[str] = None
    details: Optional[dict[str, Any]] = None

# --- booking/appointment-created.json ---
class AppointmentCreated(BaseModel):
    class Config:
        extra = Extra.forbid

    appointmentId: str
    patientId: str
    start: datetime
    end: datetime
    location: Optional[str] = None

# --- booking/booking-search-request.json ---
class BookingSearchRequest(BaseModel):
    class Config:
        extra = Extra.forbid

    serviceType: constr(pattern=r'^[A-Za-z0-9._:-]+$', min_length=1, max_length=64)
    windowStart: datetime
    windowEnd: datetime
    location: Optional[
        constr(pattern=r'^[-A-Za-z0-9._:\\s]+$', min_length=2, max_length=64)
    ] = None

# --- common/dlq-event.json ---
class DlqEvent(BaseModel):
    class Config:
        extra = Extra.forbid

    originalTopic: str
    correlationId: Optional[str] = None
    errorCode: Optional[str] = None
    errorMessage: Optional[str] = None
    payloadRef: Optional[Union[dict[str, Any], str]] = Field(
        None, description='Opaque reference or small safe context; avoid PHI.'
    )
    ts: datetime

# --- common/error-envelope.json ---
class Code(Enum):
    unauthorized = 'unauthorized'
    forbidden = 'forbidden'
    invalid_input = 'invalid_input'
    unsupported_media_type = 'unsupported_media_type'
    payload_too_large = 'payload_too_large'
    conflict = 'conflict'
    upstream_timeout = 'upstream_timeout'
    upstream_unavailable = 'upstream_unavailable'
    internal_error = 'internal_error'
    too_many_requests = 'too_many_requests'
    busy = 'busy'
    invalid_fhir = 'invalid_fhir'

class Error(BaseModel):
    class Config:
        extra = Extra.forbid

    code: Code
    message: str
    details: Optional[dict[str, Any]] = None
    correlationId: Optional[str] = None

class ErrorEnvelope(BaseModel):
    class Config:
        extra = Extra.forbid

    error: Error = Field(..., title='ErrorObject')

# --- common/event-envelope.json ---
class EventEnvelope(BaseModel):
    class Config:
        extra = Extra.forbid

    id: str
    topic: str
    timestamp: datetime
    payload: Optional[Union[dict[str, Any], list[Any], str, float, bool]]
    correlationId: Optional[str] = None

# --- config/orchestrator.json ---
class Fallback(Enum):
    rules = 'rules'
    none = 'none'

class CircuitBreaker(BaseModel):
    class Config:
        extra = Extra.forbid

    failureThreshold: conint(ge=1, le=10)
    openMs: conint(ge=1000, le=600000)

class SafetyGate(BaseModel):
    class Config:
        extra = Extra.forbid

    timeoutMs: Optional[conint(ge=50, le=10000)] = 2000
    maxRetries: Optional[conint(ge=0, le=5)] = 2
    fallback: Optional[Fallback] = 'rules'
    circuitBreaker: Optional[CircuitBreaker] = None

class RateLimit(BaseModel):
    class Config:
        extra = Extra.forbid

    perIpRps: Optional[confloat(ge=0.0, le=1000.0)] = 5
    perIpBurst: Optional[conint(ge=0, le=500)] = 20
    perTenantRps: Optional[confloat(ge=0.0, le=1000.0)] = 5
    perTenantBurst: Optional[conint(ge=0, le=500)] = 20

class Http(BaseModel):
    class Config:
        extra = Extra.forbid

    bodyLimitBytes: Optional[conint(ge=1024, le=10485760)] = 262144
    rateLimit: Optional[RateLimit] = None

class Idempotency(BaseModel):
    class Config:
        extra = Extra.forbid

    ttlSeconds: Optional[conint(ge=10, le=86400)] = 600

class Concurrency(BaseModel):
    class Config:
        extra = Extra.forbid

    globalMax: Optional[conint(ge=1, le=10000)] = 200
    perState: Optional[dict[str, conint(ge=1, le=10000)]] = None

class Outbound(BaseModel):
    class Config:
        extra = Extra.forbid

    allowlistHosts: Optional[list[str]] = []

class Redaction(BaseModel):
    class Config:
        extra = Extra.forbid

    fields: Optional[list[str]] = []

class Logging(BaseModel):
    class Config:
        extra = Extra.forbid

    redaction: Optional[Redaction] = None

class OrchestratorConfig(BaseModel):
    class Config:
        extra = Extra.forbid

    practiceId: str
    safetyGate: Optional[SafetyGate] = None
    http: Optional[Http] = None
    idempotency: Optional[Idempotency] = None
    concurrency: Optional[Concurrency] = None
    outbound: Optional[Outbound] = None
    logging: Optional[Logging] = None

# --- features/acuity-signal.json ---
class PredictedClass(Enum):
    emergency = 'emergency'
    urgent = 'urgent'
    routine = 'routine'

class Explanation(BaseModel):
    class Config:
        extra = Extra.forbid

    feature: str = Field(..., description='Feature name or token.')
    contribution: float = Field(
        ..., description='Signed contribution toward the emergency decision.'
    )

class AcuitySignalFeatures(BaseModel):
    class Config:
        extra = Extra.forbid

    schemaVersion: constr(pattern=r'^v[0-9]+(\.[0-9]+){0,2}$') = Field(
        ..., description='Semantic version of this payload.'
    )
    generatedAt: datetime = Field(
        ..., description='Timestamp when the signal was computed (UTC).'
    )
    modelVersion: Optional[constr(max_length=64)] = Field(
        None, description='Version identifier of the model producing the scores.'
    )
    predictedClass: Optional[PredictedClass] = Field(
        None, description='Argmax decision from the acuity classifier.'
    )
    emergencyProbability: Optional[confloat(ge=0.0, le=1.0)] = Field(
        None, description='Probability of the emergency class.'
    )
    urgentProbability: Optional[confloat(ge=0.0, le=1.0)] = Field(
        None, description='Probability of the urgent class.'
    )
    routineProbability: Optional[confloat(ge=0.0, le=1.0)] = Field(
        None, description='Probability of the routine class.'
    )
    symptomEmbedding: Optional[list[float]] = Field(
        None,
        description='Fixed-length embedding derived from symptom/document encoding.',
        max_items=512,
        min_items=1,
    )
    patientAgeYears: Optional[conint(ge=0, le=120)] = Field(
        None,
        description='Patient age in years at the time the feature vector was generated.',
    )
    comorbidityFlags: Optional[dict[str, bool]] = Field(
        None,
        description='Map of comorbidity indicators used by the model. Keys follow snake_case ICD topic names.',
    )
    explanations: Optional[list[Explanation]] = Field(
        None,
        description='Model interpretability artefacts (e.g., SHAP style contributions).',
        max_items=32,
    )
    expiresAt: Optional[datetime] = Field(
        None,
        description='Optional expiry timestamp (UTC) after which the signal must be recomputed.',
    )

# --- features/triage-core.json ---
class TriageCoreFeatures(BaseModel):
    class Config:
        extra = Extra.forbid

    schemaVersion: constr(pattern=r'^v[0-9]+(\.[0-9]+){0,2}$') = Field(
        ...,
        description='Semantic version of the feature payload. Bump on backwards-incompatible changes.',
    )
    generatedAt: datetime = Field(
        ..., description='Timestamp when the feature vector was produced (UTC).'
    )
    acuity: Optional[confloat(ge=0.0, le=1.0)] = Field(
        None, description='Predicted emergency probability or severity score.'
    )
    risk: Optional[confloat(ge=0.0, le=1.0)] = Field(
        None, description='Risk-of-deterioration signal derived from patient history.'
    )
    complexity: Optional[confloat(ge=0.0, le=1.0)] = Field(
        None,
        description='Operational complexity estimate capturing comorbidities and care coordination needs.',
    )
    time: Optional[confloat(ge=0.0, le=1.0)] = Field(
        None,
        description='Time-sensitivity score (e.g., symptom onset, follow-up deadlines).',
    )
    capacity: Optional[confloat(ge=0.0, le=1.0)] = Field(
        None, description='Signal representing provider/network capacity constraints.'
    )
    compositeScore: Optional[float] = Field(
        None, description='Weighted score computed from the component features.'
    )
    source: Optional[constr(max_length=64)] = Field(
        None,
        description='Identifier of the pipeline or model that produced the feature vector.',
    )
    expiresAt: Optional[datetime] = Field(
        None,
        description='Optional expiry timestamp (UTC) after which the vector should be refreshed.',
    )
    extensions: Optional[
        dict[str, Optional[Union[float, constr(max_length=128), bool]]]
    ] = Field(
        None,
        description='Reserved for additive signals that do not yet justify a schema bump. Keys must be lowerCamelCase.',
    )

# --- ics/referral-ack.json ---
class IcsReferralAck(BaseModel):
    class Config:
        extra = Extra.forbid

    referralId: str
    accepted: bool
    note: Optional[str] = None

# --- ics/referral-request.json ---
class IcsReferralRequest(BaseModel):
    class Config:
        extra = Extra.forbid

    referralId: str
    patientId: str
    org: str
    reason: str

# --- ingest/portal-submission.json ---
class Patient(BaseModel):
    class Config:
        extra = Extra.forbid

    id: constr(pattern=r'^[A-Za-z0-9._:-]+$', min_length=1, max_length=64)
    dob: Optional[date] = None
    locale: Optional[constr(pattern=r'^[a-z]{2}(?:-[A-Z]{2})?$')] = None

class Attachment(BaseModel):
    class Config:
        extra = Extra.forbid

    contentType: constr(
        pattern=r'^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$',
        min_length=3,
        max_length=128,
    )
    url: AnyUrl

class Channel(Enum):
    web = 'web'
    ivr = 'ivr'

class PortalSubmission(BaseModel):
    class Config:
        extra = Extra.forbid

    practiceId: constr(pattern=r'^[A-Za-z0-9._:-]+$', min_length=1, max_length=64)
    patient: Patient
    narrative: constr(max_length=500000)
    attachments: Optional[list[Attachment]] = None
    channel: Channel

# --- pharmacy/pharmacy-referral.json ---
class Slot(BaseModel):
    class Config:
        extra = Extra.forbid

    start: datetime
    end: datetime

class PharmacyReferral(BaseModel):
    class Config:
        extra = Extra.forbid

    patientId: str
    condition: str
    pharmacyOrg: str
    slot: Optional[Slot] = None

# --- portal/notify.json ---
class State(Enum):
    UP = 'UP'
    DOWN = 'DOWN'
    OOH = 'OOH'

class PortalNotify(BaseModel):
    class Config:
        extra = Extra.forbid

    practiceId: constr(pattern=r'^[a-zA-Z0-9._:-]+$', min_length=1, max_length=64) = (
        Field(..., description='Stable practice identifier (no PHI).')
    )
    state: State = Field(..., description='Resulting portal availability state.')
    reasonCode: Optional[constr(pattern=r'^[A-Z0-9_]{1,64}$')] = Field(
        None,
        description='Machine-readable reason (e.g., CORE_HOURS, MAINTENANCE, CONFIG_INVALID).',
    )
    at: datetime = Field(
        ..., description='Timestamp for the observed state change (UTC).'
    )

# --- safety/safety-decision.json ---
class Outcome(Enum):
    DIVERTED = 'DIVERTED'
    SAFE_TO_CONTINUE = 'SAFE_TO_CONTINUE'

class SafetyDecision(BaseModel):
    class Config:
        extra = Extra.forbid

    outcome: Outcome
    reason: Optional[str] = None

# --- scribe/scribe-audio.json ---
class ScribeAudio(BaseModel):
    class Config:
        extra = Extra.forbid

    encounterId: constr(pattern=r'^[A-Za-z0-9._:-]+$', min_length=1, max_length=64)
    audioUrl: AnyUrl
    contentType: constr(
        pattern=r'^audio/[A-Za-z0-9!#$&^_.+-]{1,63}$', min_length=3, max_length=128
    )
    diarization: Optional[bool] = None

# --- tasks/task-created.json ---
class Priority(Enum):
    STAT = 'STAT'
    URGENT = 'URGENT'
    SOON = 'SOON'
    ROUTINE = 'ROUTINE'

class TaskCreated(BaseModel):
    class Config:
        extra = Extra.forbid

    taskId: str
    patientId: str
    priority: Priority
    owner: Optional[str] = None

# --- telephony/call-transcribed.json ---
class CallTranscribed(BaseModel):
    class Config:
        extra = Extra.forbid

    callId: str
    patientId: Optional[str] = None
    transcript: str
    lang: Optional[str] = None

# --- telephony/intent-classified.json ---
class IntentClassified(BaseModel):
    class Config:
        extra = Extra.forbid

    callId: str
    intent: str
    confidence: Optional[float] = None

# --- triage/triage-input.json ---
class TriageInput(BaseModel):
    class Config:
        extra = Extra.forbid

    patientId: str
    narrative: str
    features: Optional[dict[str, Optional[Union[str, float, bool]]]] = None
