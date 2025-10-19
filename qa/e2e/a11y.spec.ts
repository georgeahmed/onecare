/* @vitest-environment jsdom */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import axe from 'axe-core';
import { describe, it, expect } from 'vitest';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'html');
const ARTIFACT_DIR = join(process.cwd(), 'artifacts', 'qa', 'a11y');

mkdirSync(ARTIFACT_DIR, { recursive: true });

type AxeResults = Awaited<ReturnType<typeof axe.run>>;

describe('Accessibility smoke checks', () => {
  it('portal intake form renders without critical issues', async () => {
    await runAxe('portal-intake.html', {
      name: 'portal-intake',
      description: 'Portal intake form, default theme',
    });
  });

  it('booking flow table passes in RTL + high contrast', async () => {
    await runAxe('booking-flow.html', {
      name: 'booking-flow-rtl-contrast',
      description: 'Booking flow grid in RTL / high contrast',
      mutateDocument: () => {
        document.documentElement.setAttribute('dir', 'rtl');
        document.documentElement.dataset.theme = 'high-contrast';
        document.body.classList.add('theme-high-contrast');
      },
    });
  });

  it('error view announces issues appropriately', async () => {
    await runAxe('portal-error.html', {
      name: 'portal-error-view',
      description: 'Error alert view',
    });
  });
});

type AxeRunOptions = {
  name: string;
  description: string;
  mutateDocument?: () => void;
};

async function runAxe(fixture: string, options: AxeRunOptions) {
  loadFixture(fixture);
  if (options.mutateDocument) {
    options.mutateDocument();
  }
  const results: AxeResults = await axe.run(document, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa'],
    },
  });

  const criticalViolations = results.violations.filter((violation) => violation.impact === 'critical');
  expect(criticalViolations, describeViolations(criticalViolations)).toHaveLength(0);

  const artifactPath = join(ARTIFACT_DIR, `${options.name}.json`);
  const artifact = {
    description: options.description,
    violations: results.violations,
    passes: results.passes,
    incomplete: results.incomplete,
  };
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
}

function loadFixture(name: string) {
  const html = readFileSync(join(FIXTURE_DIR, name), 'utf8');
  document.open();
  document.write(html);
  document.close();
}

function describeViolations(violations: AxeResults['violations']): string {
  if (violations.length === 0) return '';
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => `selector: ${node.target.join(' > ')} | summary: ${node.failureSummary}`)
        .join('\n');
      return `${violation.id} (${violation.impact})\n${nodes}`;
    })
    .join('\n\n');
}
