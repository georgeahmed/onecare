#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const readline = require('readline');

const DEFAULT_INPUT = process.env.ANALYTICS_SINK_PATH || 'var/analytics/metrics.jsonl';
const DEFAULT_OUTPUT = process.env.ANALYTICS_QUALITY_REPORT || 'var/analytics/quality.md';
const DEFAULT_QUARANTINE = process.env.ANALYTICS_QUALITY_QUARANTINE || 'var/analytics/quarantine.jsonl';
const DEFAULT_ZSCORE = Number(process.env.ANALYTICS_QUALITY_ZSCORE || '3');
const MAX_SAMPLES_PER_ISSUE = 5;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const value = argv[i + 1];
    if ((token === '--input' || token === '-i') && value) {
      args.input = value;
      i += 1;
    } else if ((token === '--output' || token === '-o') && value) {
      args.output = value;
      i += 1;
    } else if ((token === '--zscore' || token === '-z') && value) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.zscore = parsed;
      }
      i += 1;
    } else if ((token === '--quarantine' || token === '-q') && value) {
      args.quarantine = value;
      i += 1;
    }
  }
  return args;
}

function toJsonSample(entry) {
  try {
    return '```json\n' + JSON.stringify(entry, null, 2) + '\n```';
  } catch {
    return '```json\n{}\n```';
  }
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readMetrics(inputPath) {
  const exists = await fileExists(inputPath);
  if (!exists) {
    console.warn(`[analytics-quality] input file not found: ${inputPath}`);
    return [];
  }

  const stream = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const records = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (err) {
      console.warn('[analytics-quality] invalid JSON line skipped', { line: trimmed.slice(0, 100), error: err.message });
    }
  }

  return records;
}

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function medianOf(sortedValues) {
  const len = sortedValues.length;
  if (!len) return null;
  const mid = Math.floor(len / 2);
  if (len % 2 === 0) {
    return (sortedValues[mid - 1] + sortedValues[mid]) / 2;
  }
  return sortedValues[mid];
}

function computeStats(values) {
  const count = values.length;
  if (!count) return { mean: null, stdDev: null, median: null, mad: null };
  const mean = values.reduce((acc, value) => acc + value, 0) / count;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / count;
  const stdDev = Math.sqrt(variance);

  const sorted = values.slice().sort((a, b) => a - b);
  const median = medianOf(sorted);
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = medianOf(deviations);

  return { mean, stdDev, median, mad };
}

function formatNumber(value) {
  if (value === null || value === undefined) return 'n/a';
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(2);
}

async function writeReport(outputPath, markdown) {
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  await fsPromises.writeFile(outputPath, markdown, 'utf8');
  console.info('[analytics-quality] wrote report', { outputPath });
}

async function writeQuarantine(outputPath, records) {
  if (!records.length) {
    console.info('[analytics-quality] no records to quarantine');
    return;
  }
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  const lines = records.map((entry) => JSON.stringify(entry));
  await fsPromises.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  console.info('[analytics-quality] wrote quarantine file', { outputPath, count: records.length });
}

async function run() {
  const { input, output, quarantine, zscore } = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(input || DEFAULT_INPUT);
  const outputPath = path.resolve(output || DEFAULT_OUTPUT);
  const quarantinePath = path.resolve(quarantine || DEFAULT_QUARANTINE);
  const threshold = zscore || DEFAULT_ZSCORE || 3;

  const records = await readMetrics(inputPath);
  const total = records.length;

  const missing = {
    name: { count: 0, samples: [] },
    value: { count: 0, samples: [] },
  };
  const numericBuckets = new Map();
  const numericSamples = new Map();
  const quarantineRecords = [];

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const entry = { ...record };

    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
      missing.name.count += 1;
      if (missing.name.samples.length < MAX_SAMPLES_PER_ISSUE) {
        missing.name.samples.push(entry);
      }
      quarantineRecords.push({ reason: 'missing_name', record: entry });
      continue;
    }
    const numeric = coerceNumber(entry.value);
    if (numeric === null) {
      missing.value.count += 1;
      if (missing.value.samples.length < MAX_SAMPLES_PER_ISSUE) {
        missing.value.samples.push(entry);
      }
      quarantineRecords.push({ reason: 'missing_numeric_value', record: entry });
    } else {
      const bucket = numericBuckets.get(entry.name) || [];
      bucket.push(numeric);
      numericBuckets.set(entry.name, bucket);

      const sampleBucket = numericSamples.get(entry.name) || [];
      if (sampleBucket.length < 2000) {
        sampleBucket.push({ value: numeric, record: entry });
        numericSamples.set(entry.name, sampleBucket);
      }
    }
  }

  const outliers = [];
  for (const [metricName, values] of numericBuckets.entries()) {
    if (values.length < 3) continue; // need enough data to judge
    const { mean, stdDev, median, mad } = computeStats(values);
    let upper;
    let lower;
    if (mad !== null && mad > 0) {
      const scaledMad = mad * 1.4826; // consistency constant for normal distribution
      upper = median + threshold * scaledMad;
      lower = median - threshold * scaledMad;
    } else if (stdDev && stdDev > 0) {
      upper = mean + threshold * stdDev;
      lower = mean - threshold * stdDev;
    } else {
      continue;
    }

    const samples = numericSamples.get(metricName) || [];
    for (const sample of samples) {
      if (sample.value > upper || sample.value < lower) {
        outliers.push({
          metric: metricName,
          value: sample.value,
          thresholdUpper: upper,
          thresholdLower: lower,
          median,
          mad:
            mad !== null && mad > 0
              ? mad * 1.4826
              : stdDev,
          record: sample.record,
        });
        quarantineRecords.push({
          reason: 'numeric_outlier',
          metric: metricName,
          value: sample.value,
          thresholdUpper: upper,
          thresholdLower: lower,
          record: sample.record,
        });
      }
    }
  }

  outliers.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const generatedAt = new Date().toISOString();
  let markdown = '';
  markdown += `# Analytics Data Quality Report\n\n`;
  markdown += `Generated: ${generatedAt}\n\n`;
  markdown += `Input: \`${inputPath}\`\n\n`;
  markdown += `Total records analysed: **${total}**\n\n`;
  markdown += `Z-score threshold: **${formatNumber(threshold)}**\n\n`;

  markdown += `## Missing Fields\n\n`;
  if (missing.name.count === 0 && missing.value.count === 0) {
    markdown += `No missing required fields detected.\n\n`;
  } else {
    markdown += `| Field | Count |\n`;
    markdown += `| --- | ---: |\n`;
    markdown += `| name | ${missing.name.count} |\n`;
    markdown += `| value | ${missing.value.count} |\n\n`;

    if (missing.name.samples.length) {
      markdown += `### Sample records missing \`name\`\n\n`;
      missing.name.samples.forEach((sample) => {
        markdown += `${toJsonSample(sample)}\n\n`;
      });
    }
    if (missing.value.samples.length) {
      markdown += `### Sample records missing numeric \`value\`\n\n`;
      missing.value.samples.forEach((sample) => {
        markdown += `${toJsonSample(sample)}\n\n`;
      });
    }
  }

  markdown += `## Numeric Outliers\n\n`;
  if (!outliers.length) {
    markdown += `No numeric outliers detected with z-score > ${formatNumber(threshold)}.\n\n`;
  } else {
    markdown += `| Metric | Value | Upper Threshold | Lower Threshold |\n`;
    markdown += `| --- | ---: | ---: | ---: |\n`;
    const preview = outliers.slice(0, 20);
    preview.forEach((entry) => {
      markdown += `| ${entry.metric} | ${formatNumber(entry.value)} | ${formatNumber(entry.thresholdUpper)} | ${formatNumber(entry.thresholdLower)} |\n`;
    });
    markdown += `\nTotal outliers flagged: **${outliers.length}**\n\n`;

    markdown += `### Outlier Samples\n\n`;
    preview.forEach((entry) => {
      markdown += `**${entry.metric}** (value: ${formatNumber(entry.value)})\n\n`;
      markdown += `${toJsonSample(entry.record)}\n\n`;
    });
  }

  await writeReport(outputPath, markdown);
  await writeQuarantine(quarantinePath, quarantineRecords);
}

run().catch((err) => {
  console.error('[analytics-quality] fatal error', err);
  process.exitCode = 1;
});
