/// <reference types="node" />

import { createServer, type InlineConfig } from 'vite';
import pa11y from 'pa11y';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Pa11yResult = Awaited<ReturnType<typeof pa11y>>;
type Pa11yIssue = Pa11yResult['issues'][number] & {
  runner?: string;
  runnerExtras?: Record<string, unknown>;
};

type RouteDefinition = {
  path: string;
  label: string;
  wait?: number;
};

const ROUTES: RouteDefinition[] = [
  { path: '/intake', label: 'Intake start', wait: 1_000 },
  { path: '/booking', label: 'Booking search', wait: 1_500 }
];

const DEFAULT_PORT = 4173;
const isCI = process.env.CI === 'true';

const resolvePortalRoot = (): string => {
  const currentFile = fileURLToPath(import.meta.url);
  const scriptsDir = dirname(currentFile);
  return resolve(scriptsDir, '..');
};

const createViteConfig = (rootDir: string, port: number): InlineConfig => ({
  root: rootDir,
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true
  },
  logLevel: isCI ? 'warn' : 'info'
});

const logIssue = (route: RouteDefinition, issue: Pa11yIssue) => {
  const runner = issue.runner ? ` [${issue.runner}]` : '';
  console.error(`  ✖ (${route.label})${runner} ${issue.message}`);
  console.error(`    Selector: ${issue.selector}`);
  if (issue.context) {
    console.error(`    Context: ${issue.context}`);
  }
  if (issue.code) {
    console.error(`    Rule: ${issue.code}`);
  }
};

const runAuditForRoute = async (baseUrl: string, route: RouteDefinition): Promise<Pa11yIssue[]> => {
  const target = new URL(route.path, baseUrl).toString();
  console.log(`• Auditing ${route.label} (${target})`);

  const result = await pa11y(
    target,
    {
      standard: 'WCAG2AA',
      wait: route.wait ?? 1_000,
      timeout: 60_000,
      chromeLaunchConfig: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    } as Parameters<typeof pa11y>[1]
  );

  const criticalIssues = result.issues.filter((issue) => issue.type === 'error');

  if (criticalIssues.length === 0) {
    console.log(`  ✓ No critical issues`);
  } else {
    console.log(`  ✖ Found ${criticalIssues.length} critical issue(s)`);
  }

  return criticalIssues;
};

const run = async (): Promise<void> => {
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  const rootDir = resolvePortalRoot();
  const reportDir = resolve(rootDir, '..', '..', 'var', 'reports');
  const reportPath = resolve(reportDir, 'portal-a11y-report.json');
  const server = await createServer(createViteConfig(rootDir, port));

  try {
    await server.listen();
    const baseUrl = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${port}`;

    console.log(`Running accessibility audit against ${baseUrl}`);

    const failures: Array<{ route: RouteDefinition; issue: Pa11yIssue }> = [];

    for (const route of ROUTES) {
      const issues = await runAuditForRoute(baseUrl, route);
      for (const issue of issues) {
        failures.push({ route, issue });
      }
    }

    const contrastIssues = failures.filter(({ issue }) =>
      issue.code?.toLowerCase().includes('contrast') ?? false
    );

    await mkdir(reportDir, { recursive: true });
    const reportPayload = {
      generatedAt: new Date().toISOString(),
      baseUrl,
      routes: ROUTES,
      totals: {
        errors: failures.length,
        contrast: contrastIssues.length
      },
      issues: failures.map(({ route, issue }) => ({
        route: route.label,
        path: route.path,
        code: issue.code,
        message: issue.message,
        selector: issue.selector
      })),
      contrastIssues: contrastIssues.map(({ route, issue }) => ({
        route: route.label,
        path: route.path,
        code: issue.code,
        message: issue.message,
        selector: issue.selector
      }))
    };

    await writeFile(reportPath, JSON.stringify(reportPayload, null, 2), 'utf8');
    console.log(`Accessibility report written to ${reportPath}`);

    if (failures.length > 0) {
      console.error('\nCritical accessibility issues detected:');
      for (const failure of failures) {
        logIssue(failure.route, failure.issue);
      }
      process.exitCode = 1;
    } else {
      console.log('\nAccessibility audit passed without critical issues.');
    }
  } catch (error) {
    console.error('Accessibility audit failed:', error);
    process.exitCode = 1;
  } finally {
    await server.close();
  }
};

run().catch((error) => {
  console.error('Unexpected error during accessibility audit:', error);
  process.exitCode = 1;
});
