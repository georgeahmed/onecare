export const Topics = {
  ingest: {
    portal: 'ingest.portal',
    telephony: 'ingest.telephony',
  },
  portal: {
    submission: 'portal.submission',
    notify: 'portal.notify',
  },
  triage: {
    input: 'triage.input',
    decision: 'triage.decision',
    tasks: 'triage.tasks',
    oohHandover: 'triage.ooh.handover',
  },
  telephony: {
    callTranscribed: 'telephony.call.transcribed',
    intentClassified: 'telephony.intent.classified',
  },
  scribe: {
    audio: 'scribe.audio',
    draft: 'scribe.draft',
  },
  booking: {
    search: 'booking.search',
    created: 'booking.created',
    appointmentCreated: 'booking.appointment.created',
    appointmentCreatedDlq: 'booking.appointment.created.dlq',
  },
  pharmacy: {
    referral: 'pharmacy.referral',
    outcome: 'pharmacy.outcome',
  },
  ics: {
    referralRequest: 'ics.referral.request',
    referralAck: 'ics.referral.ack',
  },
  tasks: {
    created: 'tasks.created',
    updated: 'tasks.updated',
  },
  audit: {
    event: 'audit.event',
  },
  analytics: {
    metric: 'analytics.metric',
  },
  broker: {
    deadLetter: 'broker.dlq',
  },
  referral: {
    created: 'referral.created',
  },
  billing: {
    claim: 'billing.claim',
    response: 'billing.response',
  },
} as const;

type TopicValue<T> = T extends string
  ? T
  : T extends Record<string, unknown>
    ? TopicValue<T[keyof T]>
    : never;

export type Topic = TopicValue<typeof Topics>;
