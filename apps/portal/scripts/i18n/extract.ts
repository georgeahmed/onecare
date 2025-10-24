/// <reference types="node" />

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../../src/i18n/messages/en';
import es from '../../src/i18n/messages/es';
import { generatePseudoMessages } from '../../src/i18n/pseudo';

type LocaleFile = {
  id: string;
  messages: Record<string, string>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_DIR = resolve(__dirname, '..', '..', 'locales');

const baseLocales: LocaleFile[] = [
  { id: 'en', messages: en },
  { id: 'es', messages: es }
];

const pseudoLocale: LocaleFile = {
  id: 'pseudo',
  messages: generatePseudoMessages(en)
};

const writeJsonFile = async (filePath: string, data: unknown): Promise<void> => {
  const normalized = JSON.stringify(data, null, 2) + '\n';
  await writeFile(filePath, normalized, 'utf8');
};

const sortMessages = (messages: Record<string, string>): Record<string, string> => {
  return Object.keys(messages)
    .sort((a, b) => a.localeCompare(b))
    .reduce<Record<string, string>>((acc, key) => {
      acc[key] = messages[key];
      return acc;
    }, {});
};

const run = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');
  await mkdir(OUTPUT_DIR, { recursive: true });

  const locales: LocaleFile[] = [...baseLocales, pseudoLocale];
  const mismatches: string[] = [];
  const englishKeys = new Set(Object.keys(en));

  for (const locale of locales) {
    const sorted = sortMessages(locale.messages);
    const targetPath = resolve(OUTPUT_DIR, `${locale.id}.json`);

    if (locale.id !== 'en' && locale.id !== 'pseudo') {
      const localeKeys = new Set(Object.keys(sorted));
      const missing = Array.from(englishKeys).filter((key) => !localeKeys.has(key));
      const extras = Array.from(localeKeys).filter((key) => !englishKeys.has(key));
      if (missing.length > 0 || extras.length > 0) {
        const summaryParts = [] as string[];
        if (missing.length > 0) {
          summaryParts.push(`missing keys: ${missing.join(', ')}`);
        }
        if (extras.length > 0) {
          summaryParts.push(`unexpected keys: ${extras.join(', ')}`);
        }
        console.warn(`⚠ Locale ${locale.id} has ${summaryParts.join('; ')}`);
        mismatches.push(`${locale.id}: ${summaryParts.join('; ')}`);
        if (checkMode) {
          continue;
        }
      }
    }

    if (checkMode) {
      try {
        const existing = await readFile(targetPath, 'utf8');
        const normalized = JSON.stringify(sorted, null, 2) + '\n';
        if (existing !== normalized) {
          mismatches.push(locale.id);
        }
      } catch {
        mismatches.push(locale.id);
      }
      continue;
    }

    await writeJsonFile(targetPath, sorted);
    // eslint-disable-next-line no-console
    console.log(`✓ Wrote ${locale.id} messages to ${targetPath}`);
  }

  if (checkMode && mismatches.length > 0) {
    const summary = mismatches.join('; ');
    throw new Error(`Locale validation failed: ${summary}`);
  }
};

run().catch((error) => {
  console.error('Failed to extract locale messages:', error);
  process.exitCode = 1;
});
