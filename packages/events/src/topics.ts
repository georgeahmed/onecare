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
    assistedCompleted: 'booking.assisted.completed',
  },
  pharmacy: {
    referral: 'pharmacy.referral',
    outcome: 'pharmacy.outcome',
    notification: 'pharmacy.notification',
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
  messaging: {
    sendDocRequested: 'messaging.senddoc.requested',
    sendDocSent: 'messaging.senddoc.sent',
    sendDocAck: 'messaging.senddoc.ack',
    sendDocNack: 'messaging.senddoc.nack',
    sendDocRetry: 'messaging.senddoc.retry',
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
