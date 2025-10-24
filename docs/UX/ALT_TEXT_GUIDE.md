# Media & Alt Text Guide

Accessible media ensures everyone can understand the interface regardless of visual ability, bandwidth, or assistive tooling. Use this checklist when introducing icons, illustrations, photos, or rich media into the portal.

## 1. Decide if media needs alternative text

- **Essential imagery (informative, functional, charts)** – Provide concise alt text that communicates the task outcome _without_ describing visual chrome. Focus on the key action or data.
- **Decorative imagery (purely aesthetic, duplicated text)** – Use `alt=""` _and_ `aria-hidden="true"` so screen readers skip it.
- **Icons inside text buttons/labels** – Mark the icon `aria-hidden="true"` and ensure the textual label conveys the meaning.
- **Illustrations that introduce a section** – Use short summaries (≤ 120 characters) that explain the intent (“Care team reviewing requests”).

## 2. Writing effective alt text

- Lead with the action or subject, not “Image of…”.
- Keep it short (ideally ≤ 120 characters) and avoid repeating nearby copy.
- Include context a sighted user would gain (e.g., outcome, urgency, emotion) when relevant.
- Skip styling terms (colour, size) unless they affect decisions (e.g., “Red warning icon” when colour conveys severity).
- Reference privacy: never include sensitive identifiers or PHI in alt text.

## 3. Captions, transcripts, and large media

- Provide captions/transcripts for audio, video, or animated explainers _before_ shipping.
- Host transcripts in version-controlled docs and link them from the README or release notes.
- For infographics or complex diagrams, link to a text alternative (markdown list, table, or structured explanation).

## 4. Implementation checklist

| Scenario | Pattern |
| --- | --- |
| Informative `<img>` | `<img src="…" alt="Summarise task outcome" />` |
| Decorative `<img>` | `<img src="…" alt="" aria-hidden="true" />` |
| SVG icon (React) | `<svg aria-hidden="true" focusable="false" …>` |
| Background-image (CSS) | Ensure adjacent text describes the purpose or add visually hidden text |
| Media captions | Wrap in `<figure>` / `<figcaption>` or use semantic lists and `aria-describedby` |

## 5. Portal-specific conventions

- **Components**: Use the shared utilities in `apps/portal/src/components/ui/*`. They already hide decorative indicators with `aria-hidden="true"`. Preserve that pattern when adding new affordances.
- **Confetti / celebratory effects**: Keep wrapped in a container with `aria-hidden="true"` so the animation does not interrupt announcements.
- **Status banners**: Ensure icons have `role="presentation"` or `aria-hidden="true"` and include the status text for screen readers.
- **Developer checklist**:
  1. Confirm new imagery follows the table above.
  2. Add reviewer notes in PR descriptions referencing this guide.
  3. Update `apps/portal/README.md` if new media types require extra tooling or captions.
  4. Run `npm run a11y:portal` (or pa11y in CI) to detect missing alt attributes.

## References

- WCAG 2.2 – [1.1.1 Non-text Content](https://www.w3.org/TR/WCAG22/#non-text-content)
- GOV.UK – [Alt text decision tree](https://www.gov.uk/service-manual/design/images)
- W3C – [Techniques for providing useful text alternatives](https://www.w3.org/WAI/tutorials/images/)
