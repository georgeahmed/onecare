#!/usr/bin/env node
/**
 * Bootstraps required JetStream streams for local development.
 * This script is idempotent: running it multiple times will ensure
 * the expected streams exist and include the desired subjects.
 */
const { connect } = require('nats');
const { parseNatsServerConfig } = require('../../packages/bus/dist/natsBus.js');

const STREAM_DEFINITIONS = [
  {
    name: 'ANALYTICS_METRIC',
    subjects: ['analytics.metric'],
  },
  {
    name: 'TRIAGE_DECISION',
    subjects: ['triage.decision'],
  },
];

async function ensureStreams() {
  const { servers, auth } = parseNatsServerConfig(process.env.NATS_URL);
  const options = { servers };
  const token = normalizeEnv(process.env.NATS_TOKEN) ?? auth.token;
  const user = normalizeEnv(process.env.NATS_USER) ?? auth.user;
  const pass = normalizeEnv(process.env.NATS_PASS) ?? auth.pass;

  if (token) {
    options.token = token;
  } else {
    if (user) options.user = user;
    if (pass) options.pass = pass;
  }

  const nc = await connect(options);
  try {
    const jsm = await nc.jetstreamManager();
    for (const stream of STREAM_DEFINITIONS) {
      await ensureStream(jsm, stream);
    }
  } finally {
    await nc.drain();
  }
}

async function ensureStream(jsm, { name, subjects }) {
  try {
    const info = await jsm.streams.info(name);
    const currentSubjects = info.config.subjects ?? [];
    const updatedSubjects = Array.from(new Set([...currentSubjects, ...subjects]));
    if (arraysEqual(currentSubjects, updatedSubjects)) {
      console.log(`Stream ${name} already present with required subjects`);
      return;
    }
    const updatedConfig = { ...info.config, subjects: updatedSubjects };
    await jsm.streams.update(name, updatedConfig);
    console.log(`Stream ${name} updated with subjects: ${updatedSubjects.join(', ')}`);
    return;
  } catch (err) {
    const message = err?.message ?? '';
    if (!message.includes('stream not found') && !message.includes('404')) {
      throw err;
    }
  }

  const config = {
    name,
    subjects,
    retention: 'limits',
    storage: 'file',
    max_msgs_per_subject: -1,
    max_msgs: -1,
    max_bytes: -1,
    discard: 'old',
    allow_rollup_hdrs: true,
    duplicate_window: 120_000_000_000, // 120 seconds (nanoseconds)
  };
  await jsm.streams.add(config);
  console.log(`Stream ${name} created with subjects: ${subjects.join(', ')}`);
}

function normalizeEnv(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

ensureStreams().catch((err) => {
  console.error('Failed to ensure JetStream streams', err);
  process.exitCode = 1;
});

