#!/usr/bin/env node

const { getBus, withMessageGuards } = require('@onecare/bus');
const { createEnvelope, Topics } = require('@onecare/events');
const { validate } = require('@onecare/domain');

const DLQ_SCHEMA_ID = 'https://onecare.example/schemas/common/dlq-event.json';

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const allowedTopics = new Set([Topics.telephony.callTranscribed, Topics.broker.deadLetter]);

  const baseBus = getBus();
  const bus = withMessageGuards(baseBus, { allowedTopics });

  const summary = {
    allowedPublishReceived: false,
    disallowedError: null,
    dlqObserved: null,
  };

  // Allowed topic flow
  const allowedMessages = [];
  const allowedSub = await bus.subscribe(Topics.telephony.callTranscribed, async (msg) => {
    allowedMessages.push(msg);
  });

  const allowedCorrelation = `smoke-allowed-${Date.now()}`;
  const allowedEnvelope = createEnvelope(
    Topics.telephony.callTranscribed,
    { test: 'allowed', at: new Date().toISOString() },
    allowedCorrelation
  );

  await bus.publish(allowedEnvelope.topic, allowedEnvelope, { 'x-correlation-id': allowedCorrelation });
  await wait(500);
  await allowedSub.unsubscribe();

  summary.allowedPublishReceived =
    allowedMessages.length === 1 &&
    allowedMessages[0].payload?.correlationId === allowedCorrelation &&
    allowedMessages[0].headers?.['x-correlation-id'] === allowedCorrelation;

  // Disallowed topic enforcement
  try {
    const disallowedEnvelope = createEnvelope(
      Topics.booking.appointmentCreated,
      { appointmentId: 'smoke-disallowed' },
      'smoke-disallowed-corr'
    );
    await bus.publish(disallowedEnvelope.topic, disallowedEnvelope);
  } catch (error) {
    summary.disallowedError = error instanceof Error ? error.message : String(error);
  }

  // DLQ validation
  const dlqMessages = [];
  const throwingSub = await bus.subscribe(Topics.telephony.callTranscribed, async () => {
    throw new Error('intentional_failure');
  });
  const dlqSub = await bus.subscribe(Topics.broker.deadLetter, async (msg) => {
    dlqMessages.push(msg);
  });

  const dlqCorrelation = `smoke-dlq-${Date.now()}`;
  const dlqEnvelope = createEnvelope(
    Topics.telephony.callTranscribed,
    { test: 'dlq', at: new Date().toISOString() },
    dlqCorrelation
  );

  try {
    await bus.publish(dlqEnvelope.topic, dlqEnvelope, { 'x-correlation-id': dlqCorrelation });
  } catch (err) {
    // expected: handler throws to force DLQ, swallow so smoke can inspect DLQ
    summary.dlqPublishError = err instanceof Error ? err.message : String(err);
  }
  await wait(1500);
  await throwingSub.unsubscribe();
  await dlqSub.unsubscribe();

  if (dlqMessages.length > 0) {
    const envelope = dlqMessages[0].payload;
    const validation = validate(DLQ_SCHEMA_ID, envelope?.payload);
    summary.dlqObserved = {
      topic: dlqMessages[0].topic,
      correlationId: envelope?.correlationId,
      originalTopic: envelope?.payload?.originalTopic,
      headers: dlqMessages[0].headers,
      schemaValid: validation.ok,
    };
    if (!validation.ok) {
      summary.dlqObserved.validationErrors = validation.errors;
      throw new Error('DLQ payload failed schema validation');
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke test failed', err);
  process.exitCode = 1;
});
