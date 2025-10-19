#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const require = createRequire(import.meta.url);

const vitestBin = require.resolve('vitest/vitest.mjs');
const workspace = join(process.cwd(), 'artifacts', 'qa');
const maxRetries = Math.max(0, Number.parseInt(process.env.CI_FLAKE_RETRIES ?? '2', 10));
const records = new Map();
const remainingRetries = new Map();
const attemptSummaries = [];

await mkdir(workspace, { recursive: true });

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

async function runSuite(targetFiles, attemptNumber) {
  const reportPath = join(workspace, `vitest-report-${attemptNumber}.json`);
  const args = ['--run', '--reporter=json', '--outputFile', reportPath];
  if (process.env.VITEST_MAX_THREADS) {
    args.push('--threads', process.env.VITEST_MAX_THREADS);
  }
  if (Array.isArray(targetFiles) && targetFiles.length > 0) {
    args.push(...targetFiles);
  }

  const exitCode = await execVitest(args);
  const report = await parseReport(reportPath);
  mergeReport(report.tests, attemptNumber);
  attemptSummaries.push({ attempt: attemptNumber, exitCode, reportPath: relative(process.cwd(), reportPath) });
  return { exitCode, report };
}

async function execVitest(args) {
  const env = { ...process.env, npm_config_workspaces: 'false' };
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestBin, ...args], {
      stdio: 'inherit',
      env,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function parseReport(reportPath) {
  const raw = await readFile(reportPath, 'utf8');
  const data = JSON.parse(raw);
  const tests = [];
  for (const suite of data.testResults ?? []) {
    const file = relative(process.cwd(), suite.name ?? suite.file ?? '');
    for (const assertion of suite.assertionResults ?? []) {
      tests.push({
        file,
        title: assertion.title,
        fullName: (assertion.fullName ?? assertion.title ?? '').trim(),
        ancestorTitles: assertion.ancestorTitles ?? [],
        status: assertion.status,
        duration: assertion.duration ?? null,
        failureMessages: assertion.failureMessages ?? [],
      });
    }
  }
  return { success: Boolean(data.success), tests };
}

function mergeReport(tests, attemptNumber) {
  for (const test of tests) {
    const key = testKey(test);
    const record = records.get(key) ?? {
      file: test.file,
      title: test.title,
      fullName: test.fullName,
      ancestorTitles: test.ancestorTitles,
      attempts: [],
    };
    record.attempts.push({
      attempt: attemptNumber,
      status: test.status,
      duration: test.duration,
      failureMessages: test.failureMessages,
    });
    records.set(key, record);
  }
}

function testKey(test) {
  return `${test.file}::${test.fullName}`;
}

function testsByStatus(status) {
  return Array.from(records.values()).filter((record) => {
    const latest = record.attempts[record.attempts.length - 1];
    return latest?.status === status;
  });
}

async function main() {
  const initial = await runSuite([], 1);
  const failingSet = new Set();
  for (const test of initial.report.tests) {
    const key = testKey(test);
    if (test.status === 'failed') {
      failingSet.add(key);
      remainingRetries.set(key, maxRetries);
    }
  }

  let attempt = 2;
  while (failingSet.size > 0) {
    if (maxRetries <= 0) {
      break;
    }
    const files = uniqueFilesFor(Array.from(failingSet));
    if (files.length === 0) break;
    const { report } = await runSuite(files, attempt);
    const nextFailing = new Set();
    for (const test of report.tests) {
      const key = testKey(test);
      if (test.status === 'failed') {
        const remaining = remainingRetries.has(key)
          ? remainingRetries.get(key)
          : maxRetries;
        const updated = (remaining ?? 0) - 1;
        remainingRetries.set(key, updated);
        if (updated >= 0) {
          nextFailing.add(key);
        }
      } else if (test.status === 'passed' && !remainingRetries.has(key)) {
        remainingRetries.set(key, maxRetries);
      }
    }

    failingSet.clear();
    for (const key of nextFailing) {
      if ((remainingRetries.get(key) ?? -1) >= 0) {
        failingSet.add(key);
      }
    }

    const attemptsExhausted = Array.from(nextFailing).filter((key) => (remainingRetries.get(key) ?? -1) < 0);
    for (const key of attemptsExhausted) {
      failingSet.delete(key);
    }

    const stillFailing = Array.from(failingSet).filter((key) => {
      const record = records.get(key);
      if (!record) return false;
      const latest = record.attempts[record.attempts.length - 1];
      return latest?.status === 'failed';
    });
    failingSet.clear();
    stillFailing.forEach((key) => failingSet.add(key));

    const exhausted = Array.from(records.entries())
      .filter(([key, record]) => {
        const latest = record.attempts[record.attempts.length - 1];
        return latest?.status === 'failed' && (remainingRetries.get(key) ?? -1) < 0;
      })
      .map(([key]) => key);
    exhausted.forEach((key) => failingSet.delete(key));

    if (attempt - 1 >= maxRetries) {
      break;
    }
    attempt += 1;
  }

  const flaky = Array.from(records.values()).filter((record) => {
    if (record.attempts.length <= 1) return false;
    const first = record.attempts[0];
    const last = record.attempts[record.attempts.length - 1];
    return first.status === 'failed' && last.status === 'passed';
  });
  const persistentFailures = testsByStatus('failed');

  await writeArtifacts({ flaky, persistentFailures });

  if (flaky.length > 0) {
    console.warn(`⚠️  Detected ${flaky.length} flaky test(s). See artifacts/qa/flaky-tests.json`);
  }
  if (persistentFailures.length > 0) {
    console.error(`❌ Tests failed after ${maxRetries} retries:`);
    for (const record of persistentFailures) {
      const latest = record.attempts[record.attempts.length - 1];
      const firstFailure = record.attempts.find((a) => a.status === 'failed');
      console.error(` - ${record.file} :: ${record.fullName}`);
      if (firstFailure?.failureMessages?.length) {
        console.error(`   ${firstFailure.failureMessages[0]}`);
      }
    }
    process.exitCode = 1;
  }
}

function uniqueFilesFor(keys) {
  const files = new Set();
  for (const key of keys) {
    const record = records.get(key);
    if (record) {
      files.add(record.file);
    }
  }
  return Array.from(files);
}

async function writeArtifacts({ flaky, persistentFailures }) {
  const matrix = {
    generatedAt: new Date().toISOString(),
    maxRetries,
    attempts: attemptSummaries,
    tests: Array.from(records.values()).map((record) => ({
      file: record.file,
      fullName: record.fullName,
      title: record.title,
      attempts: record.attempts,
    })),
  };
  await writeFile(join(workspace, 'test-matrix.json'), JSON.stringify(matrix, null, 2));
  await writeFile(
    join(workspace, 'flaky-tests.json'),
    JSON.stringify(
      flaky.map((record) => ({
        file: record.file,
        fullName: record.fullName,
        attempts: record.attempts,
      })),
      null,
      2,
    ),
  );
  await writeFile(
    join(workspace, 'persistent-failures.json'),
    JSON.stringify(
      persistentFailures.map((record) => ({
        file: record.file,
        fullName: record.fullName,
        attempts: record.attempts,
      })),
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error('vitest flake detection failed', error);
  process.exitCode = 1;
});
