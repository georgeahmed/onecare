# OneCare Portal Frontend

## Design Tokens & UI Primitives
- Core tokens live in `src/styles/tokens.css` and expose semantic colors, spacing, typography, and motion variables.
- Shared UI primitives under `src/components/ui/` (`Button`, `Input`, `Select`, `Textarea`, `Alert`) consume these tokens and keep interaction styling consistent.
- Prefer using these primitives (or extending them) instead of raw HTML controls so hover/focus states stay accessible. When custom controls are required, align with the tokens and reduced-motion guidance.

_Do:_ keep components stateless and accept standard HTML props. _Don’t:_ inline hard-coded colors or spacing that bypass tokens.

## Theme Management
- `ThemeProvider` (`src/theme/index.tsx`) wraps the app and applies `light`, `dark`, or `high-contrast` themes. Preferences persist to `localStorage` and default to OS contrast/color hints.
- `ThemeSwitcher` renders the toggle in the primary header; use it when embedding the portal shell elsewhere so users can self-select their mode.
- Theme transitions temporarily disable CSS transitions to avoid flicker; custom components should respect existing variables rather than override them.

## Internationalization & Direction
- `I18nProvider` handles lazy loading locale bundles, pseudo-locales in dev, and sets `<html lang>`/`dir` automatically. Use `getLocaleMetadata(locale).direction` when you need locale-aware layout decisions.
- Locale metadata lives alongside the provider; add new locales there first, then provide message bundles under `src/i18n/messages/`.

## Intake Form UX Enhancements
- Validation is schema-driven (`SchemaForm`) and now surfaces an error summary banner (`ErrorSummary`) that links back to fields. Use `toFieldId(path)` when creating additional summary links.
- Autosave stores drafts under the key `onecare.portal.intakeDraft`. The status chip beneath the summary reads “Saving… / Saved / Restored” to keep users informed.
- Autosave helpers are isolated at the top of `IntakeForm.tsx`; any future forms should reuse the same pattern (coerce incoming drafts, debounce saves, clear on success).

## Operational Notes
- Run `npm run typecheck && npm run test` from `apps/portal` before pushing changes. Schema-driven components rely on generated types; re-run `npm run codegen` at the repo root if schemas change.
- The Playwright suite remains behind the `PORTAL_E2E_ENABLE` flag for now; enable it when validating end-to-end intake or booking flows.
