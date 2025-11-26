import { test, expect } from '@playwright/test';

const enableE2E = process.env.PORTAL_E2E_ENABLE === 'true' && process.env.PORTAL_E2E_SKIP !== 'true';
const describeIfEnabled = enableE2E ? test.describe : test.describe.skip;

describeIfEnabled('Portal Intake flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
  });

  test('switches locales and submits valid intake', async ({ page }) => {
    const localeSelect = page.getByLabel('Language');
    await localeSelect.selectOption('es');
    await expect(page.getByText('Ingreso al portal')).toBeVisible();

    await localeSelect.selectOption('en');
    await expect(page.getByText('Portal Intake')).toBeVisible();

    await page.getByLabel('Practice ID').fill('demo');
    await page.getByLabel('Patient ID').fill('patient-123');
    await page.getByLabel('Narrative').fill('Patient reports mild symptoms.');
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByRole('status')).toContainText('Submission received');
    await expect(page.getByRole('status')).toContainText('Reference');
  });

  test('shows localized error for invalid input', async ({ page }) => {
    await page.getByLabel('Language').selectOption('es');
    await expect(page.getByText('Ingreso al portal')).toBeVisible();

    await page.getByRole('button', { name: 'Enviar' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Verifique los datos resaltados');
  });
});
