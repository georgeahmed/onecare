"""AUTO-GENERATED from schemas/. DO NOT EDIT MANUALLY."""
from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from pydantic import AnyUrl, BaseModel, confloat, conint, constr, Extra, Field
from typing import Any, Literal, Optional, Union

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

    serviceType: constr(regex=r'^[A-Za-z0-9._:-]+$', min_length=1, max_length=64)
    windowStart: datetime
    windowEnd: datetime
    location: constr(regex=r'^[-A-Za-z0-9._:\\s]+$', min_length=2, max_length=64)

# --- booking/booking-search-response.json ---
class SlotView(BaseModel):
    class Config:
        extra = Extra.forbid

    id: constr(min_length=1, max_length=96)
    start: datetime
    end: datetime
    organisationId: constr(regex=r'^[A-Za-z0-9._:-]+$', min_length=1, max_length=64)
    serviceType: Optional[
        constr(regex=r'^[A-Za-z0-9._:-]+$', min_length=1, max_length=64)
    ] = None

class RejectedSlot(BaseModel):
    class Config:
        extra = Extra.forbid

    slot: SlotView
    reasons: list[constr(regex=r'^[a-z0-9_.-]+$', min_length=1, max_length=64)] = Field(
        ..., min_items=1
    )

class BookingSearchResponse(BaseModel):
    class Config:
        extra = Extra.forbid

    slots: list[SlotView] = Field(
        ..., description='Slots that passed the enhanced access filters.'
    )
    rejectedSlots: Optional[list[RejectedSlot]] = Field(
        [], description='Slots rejected by the policy along with reason codes.'
    )

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
    not_found = 'not_found'
    unsupported_media_type = 'unsupported_media_type'
    payload_too_large = 'payload_too_large'
    conflict = 'conflict'
    upstream_timeout = 'upstream_timeout'
    upstream_unavailable = 'upstream_unavailable'
    internal_error = 'internal_error'
    too_many_requests = 'too_many_requests'
    rate_limited = 'rate_limited'
    busy = 'busy'
    over_capacity = 'over_capacity'
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

class Booking(BaseModel):
    class Config:
        extra = Extra.forbid

    availabilityTimeoutMs: Optional[conint(ge=200, le=10000)] = 2000

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
    booking: Optional[Booking] = None

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

    schemaVersion: constr(regex=r'^v[0-9]+(\.[0-9]+){0,2}$') = Field(
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

# --- features/registry.json ---
class Model(BaseModel):
    __root__: Any

# --- features/registry.schema.json ---
class PiiClassification(Enum):
    none = 'none'
    limited = 'limited'
    phi = 'phi'

class Entity(BaseModel):
    class Config:
        extra = Extra.forbid

    name: constr(regex=r'^[a-z][a-zA-Z0-9]*$') = Field(
        ..., description='CamelCase entity identifier (e.g., patient, triageCase).'
    )
    description: str = Field(
        ..., description='Summary of the entity and how it is derived.'
    )
    keys: list[constr(regex=r'^[a-z][a-zA-Z0-9]*$')] = Field(
        ..., description='Primary join keys (ordered by precedence).', min_items=1
    )
    surrogateKeys: Optional[list[constr(regex=r'^[a-z][a-zA-Z0-9]*$')]] = Field(
        [], description='Optional surrogate identifiers stored alongside natural keys.'
    )
    piiClassification: PiiClassification = Field(
        ..., description='PII/PHI classification for the entity identifiers.'
    )

class Classification(Enum):
    phi = 'phi'
    pii = 'pii'
    deidentified = 'deidentified'

class Freshness(BaseModel):
    class Config:
        extra = Extra.forbid

    slaMinutes: conint(ge=1) = Field(
        ...,
        description='Maximum tolerated age (minutes) for the latest feature snapshot.',
    )
    expiryMinutes: Optional[conint(ge=1)] = Field(
        None,
        description='Hard expiry after which the feature snapshot must be recomputed.',
    )

class Format(Enum):
    parquet = 'parquet'
    delta = 'delta'

class Offline(BaseModel):
    class Config:
        extra = Extra.forbid

    format: Format = Field(..., description='Primary file/storage format.')
    partitioning: list[constr(min_length=1)] = Field(
        ..., description='Partition columns used for offline storage.', min_items=1
    )
    pitTable: str = Field(..., description='Name of the point-in-time table/view.')

class Online(BaseModel):
    class Config:
        extra = Extra.forbid

    store: str = Field(
        ..., description='Target online store implementation (e.g., redis, memory).'
    )
    ttlSeconds: Optional[conint(ge=1)] = Field(
        None, description='Default TTL for online entries in seconds.'
    )

class Materialization(BaseModel):
    class Config:
        extra = Extra.forbid

    offline: Offline
    online: Optional[Online] = None

class FeatureSet(BaseModel):
    class Config:
        extra = Extra.forbid

    name: constr(regex=r'^[a-z][a-z0-9-]*$') = Field(
        ..., description='Kebab-case feature set identifier.'
    )
    title: str = Field(..., description='Human-readable title.')
    entity: str = Field(
        ...,
        description='Entity name (from entities[].name) this feature set is keyed on.',
    )
    schemaId: AnyUrl = Field(
        ..., description='Canonical schema identifier for the payload.'
    )
    description: str = Field(
        ..., description='Purpose of the feature set and typical consumers.'
    )
    classification: Classification = Field(
        ..., description='Data classification for payload fields.'
    )
    owners: list[constr(min_length=1)] = Field(
        ..., description='Owning teams or service groups.', min_items=1
    )
    sources: list[constr(min_length=1)] = Field(
        ...,
        description='Upstream systems or jobs producing this feature set.',
        min_items=1,
    )
    freshness: Freshness = Field(
        ..., description='Freshness SLO and expiry configuration.'
    )
    materialization: Materialization = Field(
        ..., description='Offline/online materialisation strategy for this feature set.'
    )
    tags: Optional[list[constr(min_length=1)]] = Field(
        None, description='Search or governance tags.'
    )

class FeatureRegistry(BaseModel):
    class Config:
        extra = Extra.forbid

    version: constr(regex=r'^v[0-9]+(\.[0-9]+){0,2}$') = Field(
        ..., description='Semantic version of the registry metadata.'
    )
    entities: list[Entity] = Field(
        ...,
        description='Entity definitions used as join keys for feature sets.',
        min_items=1,
    )
    featureSets: list[FeatureSet] = Field(
        ..., description='Registered feature sets and their schemas.', min_items=1
    )

# --- features/triage-core.json ---
class TriageCoreFeatures(BaseModel):
    class Config:
        extra = Extra.forbid

    schemaVersion: constr(regex=r'^v[0-9]+(\.[0-9]+){0,2}$') = Field(
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

# --- fhir/bundle-entry-resource.json ---
class Patient(BaseModel):
    class Config:
        extra = Extra.allow

    resourceType: Literal['Patient'] = Field(..., const=True)
    id: constr(min_length=1)

class Status(Enum):
    completed = 'completed'
    in_progress = 'in-progress'
    entered_in_error = 'entered-in-error'

class Topic(BaseModel):
    class Config:
        extra = Extra.allow

    text: Optional[str] = None

class Subject(BaseModel):
    class Config:
        extra = Extra.allow

    reference: Optional[constr(min_length=1)] = None

class PayloadItem(BaseModel):
    class Config:
        extra = Extra.allow

    contentString: Optional[str] = None

class NoteItem(BaseModel):
    class Config:
        extra = Extra.allow

    text: Optional[str] = None

class Communication(BaseModel):
    class Config:
        extra = Extra.allow

    resourceType: Literal['Communication'] = Field(..., const=True)
    status: Status
    topic: Optional[Topic] = None
    subject: Optional[Subject] = None
    medium: Optional[list[dict[str, Any]]] = None
    payload: Optional[list[PayloadItem]] = None
    note: Optional[list[NoteItem]] = None

class Status1(Enum):
    current = 'current'
    superseded = 'superseded'
    entered_in_error = 'entered-in-error'

class Attachment(BaseModel):
    class Config:
        extra = Extra.allow

    url: AnyUrl
    contentType: constr(min_length=1)

class ContentItem(BaseModel):
    class Config:
        extra = Extra.allow

    attachment: Attachment

class DocumentReference(BaseModel):
    class Config:
        extra = Extra.allow

    resourceType: Literal['DocumentReference'] = Field(..., const=True)
    status: Status1
    subject: Optional[Subject] = None
    content: list[ContentItem] = Field(..., min_items=1)

class FhirBundleEntryResource(BaseModel):
    __root__: Union[Patient, Communication, DocumentReference] = Field(
        ..., discriminator='resourceType', title='FHIR Bundle Entry Resource'
    )

# --- fhir/bundle-transaction.json ---
class Method(Enum):
    POST = 'POST'
    PUT = 'PUT'

class Request(BaseModel):
    class Config:
        extra = Extra.allow

    method: Method
    url: constr(min_length=1)

class Patient(BaseModel):
    class Config:
        extra = Extra.allow

    resourceType: Literal['Patient'] = Field(..., const=True)
    id: constr(min_length=1)

class Status(Enum):
    completed = 'completed'
    in_progress = 'in-progress'
    entered_in_error = 'entered-in-error'

class Topic(BaseModel):
    class Config:
        extra = Extra.allow

    text: Optional[str] = None

class Subject(BaseModel):
    class Config:
        extra = Extra.allow

    reference: Optional[constr(min_length=1)] = None

class PayloadItem(BaseModel):
    class Config:
        extra = Extra.allow

    contentString: Optional[str] = None

class NoteItem(BaseModel):
    class Config:
        extra = Extra.allow

    text: Optional[str] = None

class Communication(BaseModel):
    class Config:
        extra = Extra.allow

    resourceType: Literal['Communication'] = Field(..., const=True)
    status: Status
    topic: Optional[Topic] = None
    subject: Optional[Subject] = None
    medium: Optional[list[dict[str, Any]]] = None
    payload: Optional[list[PayloadItem]] = None
    note: Optional[list[NoteItem]] = None

class Status1(Enum):
    current = 'current'
    superseded = 'superseded'
    entered_in_error = 'entered-in-error'

class Attachment(BaseModel):
    class Config:
        extra = Extra.allow

    url: AnyUrl
    contentType: constr(min_length=1)

class ContentItem(BaseModel):
    class Config:
        extra = Extra.allow

    attachment: Attachment

class DocumentReference(BaseModel):
    class Config:
        extra = Extra.allow

    resourceType: Literal['DocumentReference'] = Field(..., const=True)
    status: Status1
    subject: Optional[Subject] = None
    content: list[ContentItem] = Field(..., min_items=1)

class EntryItem(BaseModel):
    class Config:
        extra = Extra.allow

    fullUrl: constr(
        regex=r'^urn:uuid:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    )
    request: Request
    resource: Union[Patient, Communication, DocumentReference] = Field(
        ..., discriminator='resourceType', title='FHIR Bundle Entry Resource'
    )

class FhirTransactionBundle(BaseModel):
    class Config:
        extra = Extra.allow

    resourceType: str = Field('Bundle', const=True)
    type: str = Field('transaction', const=True)
    entry: list[EntryItem] = Field(..., min_items=1)

# --- fhir/communication.json ---
class Status(Enum):
    completed = 'completed'
    in_progress = 'in-progress'
    entered_in_error = 'entered-in-error'

class Topic(BaseModel):
    class Config:
        extra = Extra.allow

    text: Optional[str] = None

class Subject(BaseModel):
    class Config:
        extra = Extra.allow

    reference: Optional[constr(min_length=1)] = None

class PayloadItem(BaseModel):
    class Config:
        extra = Extra.allow

    contentString: Optional[str] = None

class NoteItem(BaseModel):
    class Config:
        extra = Extra.allow

    text: Optional[str] = None

class FhirCommunicationMinimal(BaseModel):
    class Config:
        extra = Extra.allow

    resourceType: str = Field('Communication', const=True)
    status: Status
    topic: Optional[Topic] = None
    subject: Optional[Subject] = None
    medium: Optional[list[dict[str, Any]]] = None
    payload: Optional[list[PayloadItem]] = None
    note: Optional[list[NoteItem]] = None

# --- fhir/document-reference.json ---
class Status(Enum):
    current = 'current'
    superseded = 'superseded'
    entered_in_error = 'entered-in-error'

class Subject(BaseModel):
    class Config:
        extra = Extra.allow

    reference: Optional[constr(min_length=1)] = None

class Attachment(BaseModel):
    class Config:
        extra = Extra.allow

    url: AnyUrl
    contentType: constr(min_length=1)

class ContentItem(BaseModel):
    class Config:
        extra = Extra.allow

    attachment: Attachment

class FhirDocumentreferenceMinimal(BaseModel):
    class Config:
        extra = Extra.allow

    resourceType: str = Field('DocumentReference', const=True)
    status: Status
    subject: Optional[Subject] = None
    content: list[ContentItem] = Field(..., min_items=1)

# --- fhir/patient.json ---
class FhirPatientMinimal(BaseModel):
    class Config:
        extra = Extra.allow

    resourceType: str = Field('Patient', const=True)
    id: constr(min_length=1)

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

    id: constr(regex=r'^[A-Za-z0-9._:-]+$', min_length=1, max_length=64)
    dob: Optional[date] = None
    locale: Optional[constr(regex=r'^[a-z]{2}(?:-[A-Z]{2})?$')] = None

class Attachment(BaseModel):
    class Config:
        extra = Extra.forbid

    contentType: constr(
        regex=r'^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$',
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

    practiceId: constr(regex=r'^[A-Za-z0-9._:-]+$', min_length=1, max_length=64)
    patient: Patient
    narrative: constr(max_length=500000)
    attachments: Optional[list[Attachment]] = None
    channel: Channel

# --- pharmacy/pharmacy-outcome.json ---
class Status(Enum):
    accepted = 'accepted'
    queued = 'queued'
    rejected = 'rejected'

class Slot(BaseModel):
    class Config:
        extra = Extra.forbid

    start: datetime
    end: datetime

class PharmacyOutcome(BaseModel):
    class Config:
        extra = Extra.forbid

    serviceRequestId: constr(min_length=1)
    organisationId: constr(min_length=1)
    status: Status
    referralReference: constr(min_length=1)
    code: Optional[constr(min_length=1)] = None
    message: Optional[constr(min_length=1)] = None
    summary: Optional[constr(min_length=1)] = None
    condition: Optional[constr(min_length=1)] = None
    severity: Optional[constr(min_length=1)] = None
    slot: Optional[Slot] = None
    recordedAt: datetime
    escalated: Optional[bool] = None

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

    practiceId: constr(regex=r'^[a-zA-Z0-9._:-]+$', min_length=1, max_length=64) = (
        Field(..., description='Stable practice identifier (no PHI).')
    )
    state: State = Field(..., description='Resulting portal availability state.')
    reasonCode: Optional[constr(regex=r'^[A-Z0-9_]{1,64}$')] = Field(
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

    encounterId: constr(regex=r'^[A-Za-z0-9._:-]+$', min_length=1, max_length=64)
    audioUrl: AnyUrl
    contentType: constr(
        regex=r'^audio/[A-Za-z0-9!#$&^_.+-]{1,63}$', min_length=3, max_length=128
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

# --- triage/triage-decision.json ---
class Priority(Enum):
    STAT = 'STAT'
    URGENT = 'URGENT'
    SOON = 'SOON'
    ROUTINE = 'ROUTINE'

class Assignment(BaseModel):
    class Config:
        extra = Extra.forbid

    owner: Optional[constr(min_length=1)] = None
    team: Optional[constr(min_length=1)] = None

class TriageDecision(BaseModel):
    class Config:
        extra = Extra.forbid

    patientId: constr(min_length=1)
    score: confloat(ge=0.0, le=1.0)
    priority: Priority
    reasons: Optional[list[constr(regex=r'^[a-z0-9_.-]{1,64}$')]] = Field(
        None, max_items=10
    )
    duplicateOf: Optional[constr(min_length=1)] = None
    assignment: Optional[Assignment] = None
    features: Optional[dict[str, Optional[Union[float, str, bool]]]] = None
    generatedAt: Optional[datetime] = None

# --- triage/triage-input.json ---
class TriageInput(BaseModel):
    class Config:
        extra = Extra.forbid

    patientId: str
    narrative: str
    features: Optional[dict[str, Optional[Union[str, float, bool]]]] = None
