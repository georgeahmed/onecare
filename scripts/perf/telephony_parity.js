#!/usr/bin/env node

/**
 * Telephony parity load probe
 *
 * Simulates the IVR → ASR → Intent stack using in-repo stubs to measure
 * stage timings, throughput, and routing decisions. Intended for parity checks
 * without requiring external telephony services.
 */

const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const { MemoryBus } = require('@onecare/bus');
const { Topics, createEnvelope } = require('@onecare/events');
const {
  IvrIngestAdapter,
  InMemoryAudioStore,
} = require('../../apps/telephony/dist/adapters/ivr.adapter.js');
const {
  StubAsrClient,
  buildCallTranscribed,
} = require('../../apps/telephony/dist/adapters/asr.client.js');
const {
  StubIntentClassifier,
  buildIntentClassifiedEvent,
} = require('../../apps/telephony/dist/adapters/intent.classifier.js');

// Configuration with sensible defaults; override via environment variables.
const totalCalls = positiveNumber(process.env.TELEPHONY_PARITY_CALLS, 200);
const concurrency = positiveNumber(process.env.TELEPHONY_PARITY_CONCURRENCY, 10);
const chunkCount = positiveNumber(process.env.TELEPHONY_PARITY_CHUNKS, 3);
const chunkSize = positiveNumber(process.env.TELEPHONY_PARITY_CHUNK_BYTES, 8192);
const timeoutMs = positiveNumber(process.env.TELEPHONY_PARITY_TIMEOUT_MS, 5000);
const practiceId = process.env.TELEPHONY_PARITY_PRACTICE_ID ?? 'demo';

if (!totalCalls || !concurrency || !chunkCount || !chunkSize || !timeoutMs) {
  console.error('[telephony-parity] invalid configuration: ensure positive numbers for calls, concurrency, chunks, chunk bytes, timeout');
  process.exit(1);
}

const scenarioIntents = [
  { transcript: 'Caller reports medication refill request for blood pressure pills', intent: 'telephony.medication' },
  { transcript: 'Caller wants to check billing statement charges from last month', intent: 'telephony.billing' },
  { transcript: 'Caller experiencing severe chest pain and shortness of breath', intent: 'telephony.emergency' },
  { transcript: 'Caller requesting appointment reschedule for follow up visit', intent: 'telephony.appointment' },
  { transcript: 'Caller needs nurse callback about lab results', intent: 'telephony.callback' },
];

const keywordIntents = {
  medication: 'telephony.medication',
  refill: 'telephony.medication',
  billing: 'telephony.billing',
  charges: 'telephony.billing',
  chest: 'telephony.emergency',
  emergency: 'telephony.emergency',
  appointment: 'telephony.appointment',
  reschedule: 'telephony.appointment',
  nurse: 'telephony.callback',
  callback: 'telephony.callback',
};

const transcriptsByCall = new Map();

const bus = new MemoryBus();
const audioStore = new InMemoryAudioStore();
const ivrAdapter = new IvrIngestAdapter({
  store: audioStore,
  events: {
    callStarted: async () => undefined,
    audioChunkStored: async () => undefined,
    promptQueued: async () => undefined,
    callCompleted: async () => undefined,
  },
});

const asrClient = new StubAsrClient({
  defaultLanguage: 'en',
  normalizer: (text) => {
    const match = /transcript for (.+)$/i.exec(text);
    if (!match) return text.trim();
    const callId = match[1];
    const transcript = transcriptsByCall.get(callId);
    return (transcript ?? text).trim();
  },
});

const intentClassifier = new StubIntentClassifier({
  defaultIntent: 'telephony.callback',
  confidence: 0.9,
  keywordIntents,
});

const metrics = {
  total: 0,
  success: 0,
  failures: 0,
  stageFailures: {
    ingest: 0,
    asr: 0,
    classify: 0,
  },
  stageLatencies: {
    ingest: [],
    asr: [],
    classify: [],
    total: [],
  },
  intentCounts: new Map(),
};

const busCounts = {
  callTranscribed: 0,
  intentClassified: 0,
};

bus.subscribe(Topics.telephony.callTranscribed, async () => {
  busCounts.callTranscribed += 1;
});

bus.subscribe(Topics.telephony.intentClassified, async () => {
  busCounts.intentClassified += 1;
});

async function main() {
  console.log(
    `[telephony-parity] calls=${totalCalls} concurrency=${concurrency} chunks=${chunkCount} chunkSize=${chunkSize}B practice=${practiceId}`,
  );

  const start = performance.now();
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      if (index >= totalCalls) {
        break;
      }
      nextIndex += 1;
      // eslint-disable-next-line no-await-in-loop
      await runCall(index);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, totalCalls) }, () => worker());
  await Promise.all(workers);

  const durationSeconds = (performance.now() - start) / 1000;
  const summary = buildSummary(durationSeconds);
  printSummary(summary);
  persistSummary(summary, process.env.TELEPHONY_PARITY_OUTPUT, process.env.TELEPHONY_PARITY_OUTPUT_PATH);
}

async function runCall(callIndex) {
  const callId = createId('call');
  const correlationId = createId('corr');
  const patientId = `patient-${Math.floor(Math.random() * 10_000)}`;
  const scenario = scenarioIntents[callIndex % scenarioIntents.length];
  const ingestLatencies = [];
  metrics.total += 1;
  const totalStart = performance.now();

  try {
    const session = await ivrAdapter.startCall(callId, {
      callerId: `+1${(5550000000 + callIndex).toString()}`,
      practiceId,
    });

    const ingestStart = performance.now();
    for (let sequence = 0; sequence < chunkCount; sequence += 1) {
      const chunk = crypto.randomBytes(chunkSize);
      // eslint-disable-next-line no-await-in-loop
      await session.onAudioChunk(chunk);
      ingestLatencies.push(performance.now());
    }
    const ingestDuration = performance.now() - ingestStart;
    metrics.stageLatencies.ingest.push(ingestDuration);

    transcriptsByCall.set(callId, scenario.transcript);

    const recording = await session.complete();
    const audioRef = recording.audioUrl;
    const asrStart = performance.now();
    const transcription = await asrClient.transcribe(callId, audioRef);
    const callTranscribed = buildCallTranscribed({
      callId,
      transcription,
      context: { patientId },
    });
    const asrDuration = performance.now() - asrStart;
    metrics.stageLatencies.asr.push(asrDuration);

    const callEnvelope = createEnvelope(Topics.telephony.callTranscribed, callTranscribed, correlationId);
    await bus.publish(Topics.telephony.callTranscribed, callEnvelope, { 'x-correlation-id': correlationId });

    const classificationInput = {
      callId,
      transcript: callTranscribed.transcript,
      lang: callTranscribed.lang ?? 'en',
      patientId: callTranscribed.patientId ?? null,
      correlationId,
    };

    const classifyStart = performance.now();
    const intentResult = await intentClassifier.classify(classificationInput);
    const intentEvent = buildIntentClassifiedEvent(classificationInput, intentResult);
    const classifyDuration = performance.now() - classifyStart;
    metrics.stageLatencies.classify.push(classifyDuration);

    const intentEnvelope = createEnvelope(Topics.telephony.intentClassified, intentEvent, correlationId);
    await bus.publish(Topics.telephony.intentClassified, intentEnvelope, { 'x-correlation-id': correlationId });

    incrementIntent(intentEvent.intent);

    const totalDuration = performance.now() - totalStart;
    metrics.stageLatencies.total.push(totalDuration);
    metrics.success += 1;
  } catch (error) {
    metrics.failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    categorizeFailure(message);
  } finally {
    transcriptsByCall.delete(callId);
  }
}

function categorizeFailure(message) {
  if (message.includes('chunk') || message.includes('call')) {
    metrics.stageFailures.ingest += 1;
  } else if (message.includes('transcrib')) {
    metrics.stageFailures.asr += 1;
  } else if (message.includes('intent')) {
    metrics.stageFailures.classify += 1;
  } else {
    metrics.stageFailures.classify += 1;
  }
}

function buildSummary(durationSeconds) {
  return {
    totalCalls,
    successes: metrics.success,
    failures: metrics.failures,
    stageFailures: metrics.stageFailures,
    busEvents: {
      telephony_callTranscribed: busCounts.callTranscribed,
      telephony_intentClassified: busCounts.intentClassified,
    },
    durationSeconds,
    throughputPerSecond: durationSeconds > 0 ? metrics.success / durationSeconds : 0,
    latencyMs: {
      ingest: summariseSeries(metrics.stageLatencies.ingest),
      asr: summariseSeries(metrics.stageLatencies.asr),
      classify: summariseSeries(metrics.stageLatencies.classify),
      total: summariseSeries(metrics.stageLatencies.total),
    },
    intents: Object.fromEntries(metrics.intentCounts.entries()),
  };
}

function summariseSeries(series) {
  if (!series || series.length === 0) {
    return {
      count: 0,
      average: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      max: 0,
    };
  }
  const sorted = [...series].sort((a, b) => a - b);
  const average = sorted.reduce((acc, value) => acc + value, 0) / sorted.length;
  return {
    count: sorted.length,
    average,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sortedSeries, percentileValue) {
  if (sortedSeries.length === 0) return 0;
  const rank = Math.min(sortedSeries.length - 1, Math.ceil((percentileValue / 100) * sortedSeries.length) - 1);
  return sortedSeries[rank];
}

function incrementIntent(intent) {
  const current = metrics.intentCounts.get(intent) ?? 0;
  metrics.intentCounts.set(intent, current + 1);
}

function positiveNumber(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function printSummary(summary) {
  console.log('');
  console.log('=== telephony parity summary ===');
  console.log(`Calls           : ${summary.totalCalls}`);
  console.log(`Successes       : ${summary.successes}`);
  console.log(`Failures        : ${summary.failures}`);
  console.log(`Duration (s)    : ${summary.durationSeconds.toFixed(2)}`);
  console.log(`Throughput (rps): ${summary.throughputPerSecond.toFixed(2)}`);
  console.log('Stage failures  :', summary.stageFailures);
  console.log('Bus events      :', summary.busEvents);
  console.log('Intents         :', summary.intents);
  printSeries('Ingest', summary.latencyMs.ingest);
  printSeries('ASR', summary.latencyMs.asr);
  printSeries('Classify', summary.latencyMs.classify);
  printSeries('Total', summary.latencyMs.total);
}

function persistSummary(summary, mode, outputPath) {
  if (mode === 'json' || typeof outputPath === 'string') {
    if (typeof outputPath === 'string' && outputPath.trim().length > 0) {
      const path = outputPath.trim();
      require('node:fs').writeFileSync(path, JSON.stringify(summary, null, 2));
    }
  }
  if (mode === 'json') {
    console.log(JSON.stringify(summary, null, 2));
  }
}

function printSeries(label, series) {
  if (!series || series.count === 0) {
    console.log(`${label} latency : no samples`);
    return;
  }
  console.log(
    `${label} latency (ms): count=${series.count} avg=${series.average.toFixed(2)} p50=${series.p50.toFixed(2)} p95=${series.p95.toFixed(2)} p99=${series.p99.toFixed(2)} max=${series.max.toFixed(2)}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[telephony-parity] probe failed', error);
    process.exit(1);
  });
}
