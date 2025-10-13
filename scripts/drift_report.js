#!/usr/bin/env node
'use strict';

/**
 * Generate a Markdown drift report summarising baseline vs current feature distributions.
 *
 * Supports JSON input in the following shape:
 * [
 *   {
 *     "feature": "acuity",
 *     "baseline": [0.1, 0.2, 0.3],
 *     "current": [0.15, 0.22, 0.35]
 *   }
 * ]
 *
 * Usage:
 *   node scripts/drift_report.js \
 *     --input data/drift/sample.json \
 *     --output var/reports/drift-report.md \
 *     --psi-threshold 0.2
 *
 * Environment overrides:
 *   DRIFT_REPORT_INPUT, DRIFT_REPORT_OUTPUT,
 *   DRIFT_REPORT_PSI_THRESHOLD, DRIFT_REPORT_MEAN_THRESHOLD, DRIFT_REPORT_STD_THRESHOLD
 */

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const DEFAULT_INPUT = process.env.DRIFT_REPORT_INPUT || 'data/drift/sample.json';
const DEFAULT_OUTPUT = process.env.DRIFT_REPORT_OUTPUT || 'var/reports/drift-report.md';
const DEFAULT_THRESHOLDS = {
  psi: parseThreshold(process.env.DRIFT_REPORT_PSI_THRESHOLD, 0.2),
  mean: parseThreshold(process.env.DRIFT_REPORT_MEAN_THRESHOLD, 0.1),
  std: parseThreshold(process.env.DRIFT_REPORT_STD_THRESHOLD, 0.1),
};

let evaluateDistributionDrift;
try {
  // eslint-disable-next-line global-require
  ({ evaluateDistributionDrift } = require('@onecare/feature-store-memory'));
} catch (err) {
  try {
    // Fallback to local source when package build not available.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    ({ evaluateDistributionDrift } = require('../packages/feature-store-memory/dist/drift'));
  } catch (fallbackErr) {
    console.error('[drift-report] unable to load drift metrics helper', {
      primary: err instanceof Error ? err.message : String(err),
      fallback: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
    });
    process.exitCode = 1;
  }
}

function parseThreshold(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  return Number.isNaN(num) ? fallback : Math.max(num, 0);
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    psiThreshold: DEFAULT_THRESHOLDS.psi,
    meanThreshold: DEFAULT_THRESHOLDS.mean,
    stdThreshold: DEFAULT_THRESHOLDS.std,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const next = argv[i + 1];
    if ((token === '--input' || token === '-i') && next) {
      args.input = next;
      i += 1;
    } else if ((token === '--output' || token === '-o') && next) {
      args.output = next;
      i += 1;
    } else if (token === '--psi-threshold' && next) {
      args.psiThreshold = parseThreshold(next, args.psiThreshold);
      i += 1;
    } else if (token === '--mean-threshold' && next) {
      args.meanThreshold = parseThreshold(next, args.meanThreshold);
      i += 1;
    } else if (token === '--std-threshold' && next) {
      args.stdThreshold = parseThreshold(next, args.stdThreshold);
      i += 1;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(
    [
      'Feature Drift Report',
      '',
      'Usage:',
      '  node scripts/drift_report.js [options]',
      '',
      'Options:',
      '  -i, --input <path>           JSON file containing baseline/current arrays (default data/drift/sample.json).',
      '  -o, --output <path>          Markdown output path (default var/reports/drift-report.md).',
      '      --psi-threshold <value>  PSI threshold for highlighting drift (default 0.2).',
      '      --mean-threshold <value> Mean delta threshold (default 0.1).',
      '      --std-threshold <value>  Std-dev delta threshold (default 0.1).',
      '  -h, --help                   Show this help text.',
    ].join('\n'),
  );
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function fallbackSample() {
  return [
    {
      feature: 'acuity',
      baseline: [0.31, 0.28, 0.35, 0.33, 0.29, 0.27, 0.3, 0.26, 0.34, 0.32],
      current: [0.42, 0.4, 0.45, 0.39, 0.41, 0.43, 0.46, 0.38, 0.44, 0.47],
    },
    {
      feature: 'risk',
      baseline: [0.18, 0.2, 0.22, 0.21, 0.19, 0.23, 0.2, 0.17, 0.24, 0.21],
      current: [0.19, 0.2, 0.18, 0.21, 0.2, 0.22, 0.19, 0.23, 0.2, 0.19],
    },
    {
      feature: 'capacity',
      baseline: [0.55, 0.53, 0.5, 0.48, 0.52, 0.51, 0.54, 0.49, 0.47, 0.52],
      current: [0.6, 0.62, 0.63, 0.61, 0.64, 0.59, 0.58, 0.62, 0.6, 0.65],
    },
  ];
}

async function loadDataset(inputPath) {
  const exists = await fileExists(inputPath);
  if (!exists) {
    console.warn('[drift-report] input dataset not found, using embedded sample', { inputPath });
    return fallbackSample();
  }
  const raw = await fsPromises.readFile(inputPath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Input must be an array of records');
    return parsed;
  } catch (err) {
    console.error('[drift-report] invalid JSON input, using embedded sample instead', {
      inputPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallbackSample();
  }
}

function isNumericArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function analyseFeature(record, thresholds) {
  if (!record || typeof record !== 'object') return null;
  const feature = typeof record.feature === 'string' && record.feature.trim().length > 0 ? record.feature.trim() : 'unknown';
  const baseline = record.baseline;
  const current = record.current;
  if (!isNumericArray(baseline) || !isNumericArray(current)) {
    return {
      feature,
      error: 'Baseline and current must be numeric arrays',
    };
  }
  const alerts = [];
  try {
    const metrics = evaluateDistributionDrift(baseline, current, {
      psiThreshold: thresholds.psi,
      meanDiffThreshold: thresholds.mean,
      stdDiffThreshold: thresholds.std,
      featureName: feature,
      logger: (message, context) => {
        alerts.push({ message, context });
      },
    });
    return {
      feature,
      metrics,
      alerts,
    };
  } catch (err) {
    return {
      feature,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a';
  }
  return value.toFixed(4);
}

function formatMarkdown(results, thresholds) {
  const generatedAt = new Date().toISOString();
  const header = [
    '# Feature Drift Report',
    '',
    `Generated: ${generatedAt}`,
    '',
    `Thresholds ⇒ PSI ≥ ${thresholds.psi}, |Δ mean| ≥ ${thresholds.mean}, |Δ std| ≥ ${thresholds.std}`,
    '',
    '| Feature | PSI | Mean Δ | Std Δ | Alerts | Samples | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  const body = [];
  const alerts = [];
  for (const result of results) {
    if (result.error) {
      body.push(`| ${result.feature} | n/a | n/a | n/a | :warning: | n/a | ${escapePipes(result.error)} |`);
      continue;
    }
    const metrics = result.metrics;
    const alertsTriggered = metrics.alertTriggered ? metrics.triggeredOn.join(', ') : '';
    if (metrics.alertTriggered && result.alerts) {
      for (const alert of result.alerts) {
        alerts.push(`${result.feature}: ${alert.message}`);
      }
    }
    const samples = `${metrics.meanBaseline.toFixed(4)}→${metrics.meanCurrent.toFixed(4)}`;
    const cells = [
      result.feature,
      formatNumber(metrics.psi),
      formatNumber(metrics.meanDiff),
      formatNumber(metrics.stdDiff),
      alertsTriggered ? `**${alertsTriggered}**` : '',
      samples,
      ' ',
    ];
    body.push(`| ${cells.map((cell) => (cell === '' ? ' ' : cell)).join(' | ')} |`);
  }

  const summary = alerts.length
    ? [
        '',
        '## Alerts',
        '',
        ...alerts.map((alert) => `- ${alert}`),
        '',
      ]
    : [
        '',
        '## Alerts',
        '',
        '- No thresholds exceeded.',
        '',
      ];

  return [...header, ...body, ...summary, ''].join('\n');
}

function escapePipes(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\|/g, '\\|');
}

async function writeMarkdown(outputPath, content) {
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  await fsPromises.writeFile(outputPath, content, 'utf8');
}

async function run() {
  if (typeof evaluateDistributionDrift !== 'function') {
    throw new Error('Drift helper not available; ensure @onecare/feature-store-memory is installed');
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const dataset = await loadDataset(args.input);
  const thresholds = {
    psi: args.psiThreshold,
    mean: args.meanThreshold,
    std: args.stdThreshold,
  };

  const results = dataset.map((record) => analyseFeature(record, thresholds));
  const markdown = formatMarkdown(results, thresholds);
  await writeMarkdown(path.resolve(args.output), markdown);

  console.info('[drift-report] report generated', {
    input: path.resolve(args.input),
    output: path.resolve(args.output),
    features: results.length,
  });
}

run().catch((err) => {
  console.error('[drift-report] fatal error', err);
  process.exitCode = 1;
});
