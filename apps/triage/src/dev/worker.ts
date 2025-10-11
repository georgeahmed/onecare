import { MemoryBus } from '@onecare/bus';
import { Topics, type TypedEnvelope, type TriageInput } from '@onecare/events';

// Dev-only in-memory bus consumer to demonstrate message flow
const bus = new MemoryBus();

async function main() {
  await bus.subscribe<TypedEnvelope<TriageInput>>(Topics.triage.input, (msg) => {
    const { payload, correlationId } = msg.payload as TypedEnvelope<TriageInput>;
    // eslint-disable-next-line no-console
    console.log('[triage-dev] received triage.input', { patientId: payload.patientId, correlationId });
  });
}

main();
