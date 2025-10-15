import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '../apps/portal/tests/e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.PORTAL_E2E_BASE_URL ?? 'http://localhost:5173',
    headless: process.env.PORTAL_E2E_HEADLESS !== 'false'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
