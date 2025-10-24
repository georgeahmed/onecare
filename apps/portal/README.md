# @onecare/app-portal

Patient-facing intake and booking SPA. Accessibility, localization, and privacy guardrails:

- Follow the Localization Authoring Guide (`docs/CONVENTIONS.md`) for glossary, review workflow, and content reviewer responsibilities.
- Run `npm run i18n:portal` before handing off translations and attach pseudo-locale QA screenshots when needed.
- Keep the accessibility audit (`npm run a11y:portal`) green and review the generated report at `var/reports/portal-a11y-report.json`.
- Capture media/alt-text decisions and content reviewer notes alongside PRs (link the ticket in the “Context” section). Reference the detailed checklist in `docs/UX/ALT_TEXT_GUIDE.md` when introducing new imagery or captions.

## Development quickstart

- Install dependencies once: `npm install`
- Start the dev server: `npm run dev`
- During local development the service worker still registers; use the “Application → Service Workers” panel to unregister when debugging cache issues.
- To test the offline queue, submit a booking while offline and watch the retry resume automatically once the connection stabilises.

See `docs/USAGE.md` for the full workflow, QA matrix, and troubleshooting steps.

## Booking microcopy guidelines

- Lead with action-oriented language (e.g., “Choose a time” instead of “Time selection”) and keep sentences under 20 words.
- Surface empathetic context only when it reduces anxiety (“We will hold this slot for a few minutes while you confirm.”).
- Confirmation states must reiterate key facts: slot, modality, location, idempotency key, and correlation ID.
- Error states should start with the next step (“Try again now” / “Pick another time”) before background detail.
- Avoid blame (“You entered invalid data”); focus on what the user can do (“Double-check the highlighted fields”).

Do:
- “Hang tight while we finish sending your booking.”
- “We reserved your appointment. Reference: {appointmentId}.”

Don’t:
- “Oops! Something went wrong!!!”
- “You must have lost connection.” (blame or speculation)

### Booking flow outline
1. Search: user filters by modality/date. Empty states nudge toward callback requests instead of dead ends.
2. Confirm: summary restates slot details, idempotency key, and correlation ID. Offline banner appears if the queue is active.
3. Success/Failure: success reiterates reference + calendar affordances; failures surface retry/back navigation plus offline recovery hints.

## Component usage cheat sheet

- **Buttons**: `ui-button` for primary actions, `ui-button--subtle` for safe secondary options, and disable rather than hide during async work.
- **Inputs**: Pair every input with a `<label>` and helper text; validation errors belong directly under the control.
- **Alerts/banners**: Use `ui-alert` for persistent messages and keep them dismissible only when the action is safe to repeat.
- **Modals/dialogs**: `booking` flow modals trap focus and include `aria-labelledby`/`aria-describedby`; mirror this pattern for new dialogs.
- **Layout**: Constrain forms to `max-width: 720px` and rely on CSS grid utilities from `styles/global.css`—avoid ad-hoc flexbox permutations unless necessary.

## Tests

- Unit/contract suites:

  ```bash
  npm run test -- apps/portal/test/booking/SearchSlots.test.tsx \
    apps/portal/test/booking/Calendar.test.tsx \
    apps/portal/test/booking/bookingData.test.ts \
    apps/portal/test/contracts/bookingSearchContract.test.ts
  ```

- Accessibility smoke:

  ```bash
  npm run a11y:portal
  ```

- End-to-end (Playwright): see `apps/portal/tests/e2e/README.md` for setup and execution.
