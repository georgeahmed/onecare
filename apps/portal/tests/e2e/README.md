# Booking E2E Scenarios

These scenarios exercise the full booking flow (search → select → confirm) using Playwright. They are not part of the default `npm run test` target to keep CI lightweight.

## Running locally

1. Install Playwright once:

   ```bash
   npx playwright install --with-deps
   ```

2. Start the portal in dev mode (with API stubs or msw powered mocks).

3. Execute the booking spec:

   ```bash
   npx playwright test tests/e2e/booking.spec.ts --project=chromium
   ```

The spec exercises the happy path plus a conflict-recovery retry. Update the stubbed responses in `tests/e2e/booking.spec.ts` if the API surface changes.
