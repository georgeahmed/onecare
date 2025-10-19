import { test, expect } from '@playwright/test';

const MOCK_SLOTS = [
  {
    id: 'slot-happy-1',
    start: '2025-10-14T09:00:00Z',
    end: '2025-10-14T09:15:00Z',
    modality: 'phone',
    location: 'Remote'
  }
];

const MOCK_CONFIRMATION = {
  appointmentId: 'appt-e2e-001',
  slotId: 'slot-happy-1',
  start: '2025-10-14T09:00:00Z',
  end: '2025-10-14T09:15:00Z',
  correlationId: 'corr-e2e-001'
};

const BOOKING_PATH = '/booking';

const interceptSlots = async (page) => {
  await page.route('**/booking/slots**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_SLOTS)
    });
  });
};

const interceptConfirm = async (page) => {
  await page.route('**/booking/confirm**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_CONFIRMATION)
    });
  });
};

const interceptConflictOnce = async (page) => {
  let servedConflict = false;
  await page.route('**/booking/confirm**', (route, _request) => {
    if (!servedConflict) {
      servedConflict = true;
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'conflict',
            message: 'Slot already taken'
          }
        })
      });
      return;
    }
    route.fallback();
  });
};

const selectFirstSlot = async (page) => {
  const slot = page.getByRole('option').first();
  await expect(slot).toBeVisible();
  await slot.click();
};

const confirmBooking = async (page) => {
  const confirmButton = page.getByRole('button', { name: /confirm appointment/i });
  await confirmButton.click();
};

const expectSuccessScreen = async (page) => {
  await expect(page.getByRole('heading', { name: /appointment booked/i })).toBeVisible();
  await expect(page.getByText(MOCK_CONFIRMATION.appointmentId)).toBeVisible();
};

test.describe('Booking E2E', () => {
  test('happy path', async ({ page }) => {
    await interceptSlots(page);
    await interceptConfirm(page);

    await page.goto(BOOKING_PATH);
    await selectFirstSlot(page);
    await confirmBooking(page);
    await expectSuccessScreen(page);
  });

  test('conflict recovery', async ({ page }) => {
    await interceptSlots(page);
    await interceptConflictOnce(page);
    await interceptConfirm(page);

    await page.goto(BOOKING_PATH);
    await selectFirstSlot(page);
    await confirmBooking(page);

    // Expect error view, then retry
    await expect(page.getByRole('heading', { name: /That slot was just booked/i })).toBeVisible();
    await page.getByRole('button', { name: /Find another time/i }).click();
    await confirmBooking(page);
    await expectSuccessScreen(page);
  });
});
