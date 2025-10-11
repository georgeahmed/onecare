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

export type Topic = typeof Topics[keyof typeof Topics];
