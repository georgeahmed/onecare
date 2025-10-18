# @onecare/app-portal

Patient-facing intake and booking SPA. Accessibility and localization guardrails:

- Follow the Localization Authoring Guide (`docs/CONVENTIONS.md`) for glossary, review lane, and media/alt text requirements.
- Run `npm run i18n:portal` before handing off translations and attach the pseudo-locale QA screenshots when relevant.
- Keep the accessibility audit (`npm run a11y:portal`) green and review the generated report at `var/reports/portal-a11y-report.json`.
- Document media/alt-text decisions and content reviewer notes alongside PRs (link the ticket in the “Context” section).

## Local development

```
npm install
npm run dev
```

See `docs/USAGE.md` for the full workflow, QA matrix, and troubleshooting steps.

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
