import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const configDir = dirname(fileURLToPath(import.meta.url));

const scopeTokens = (process.env.VITEST_SCOPE ?? '')
  .split(',')
  .map((token) => token.trim())
  .filter(Boolean);

const hasScope = (scope: string): boolean => scopeTokens.includes(scope) || scopeTokens.includes('all');

// Keep heavy QA/e2e suites out of the default run while allowing targeted invocations via VITEST_SCOPE.
const scopedExclude = (): string[] => {
  const base = [...configDefaults.exclude];
  if (!hasScope('qa')) {
    base.push('**/qa/**');
  }
  if (!hasScope('apps-e2e')) {
    base.push('apps/**/tests/e2e/**');
  }
  return base;
};

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts?(x)', '**/*.spec.ts?(x)'],
    exclude: scopedExclude(),
    setupFiles: [resolve(configDir, 'vitest.setup.ts')],
  }
});
