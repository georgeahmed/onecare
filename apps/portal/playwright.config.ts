import { defineConfig, devices } from '@playwright/test';

const previewPort = Number(process.env.PORTAL_E2E_PORT ?? '4173');
const previewHost = process.env.PORTAL_E2E_HOST ?? '127.0.0.1';
const skipServer = process.env.PORTAL_E2E_SKIP === 'true';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://${previewHost}:${previewPort}`,
    headless: true
  },
  webServer: skipServer
    ? undefined
    : {
        command: 'npm run preview:e2e',
        url: `http://${previewHost}:${previewPort}`,
        reuseExistingServer: !process.env.CI,
        timeout: 90_000
      },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
