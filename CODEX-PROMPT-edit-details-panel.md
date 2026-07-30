# Codex prompt: "Edit details" panel for status/target/target date/summary

Paste everything below the line into Codex, with `public/index.html` open.

Backend already built and tested (147/147 passing), not yet deployed, no D1
migration needed. Do not change anything in `worker/`. This job is only
`public/index.html`.

---

## Context

Four project fields have had no edit UI at all until now: status (the pill
next to the project name, line ~611), target text and target date (the line
under the owners row, line ~619), and summary (line 622-623). They could
only ever be set at project creation. `PATCH /api/projects/:id` already
accepts all four in one call and always has.

**Permission change alongside this:** these four fields, plus renaming, are
now admin-only server-side (previously status/target/targetDate/summary were
open to any signed-in user, that's intentionally being tightened now that a
real button will make them easy to reach). Only "Where We Are" (its existing
`data-wwa-toggle` edit control, unchanged) stays open to everyone. Build the
panel as admin-only, do not show it to a non-admin, the server also enforces
this so it isn't just cosmetic, but per the existing convention in this app,
hidden controls should actually be hidden.

## What to build

One panel, one button, covering all four fields together, not four separate
inline edits like Where We Are has. Something like:

- A single "✎ Edit details" button, admin-only, near the status pill in
  `.card-title-row` (line 605-612), similar placement/style to the existing
  `data-project-rename` Edit button right next to it.
- Clicking it opens an inline panel inside the card (reuse the show/hide
  pattern already used for `.wwa-edit` or the Key Risk edit textarea, i.e.
  toggle a hidden block to visible, swap the button to "Save" / "Cancel"),
  rather than a separate modal dialog, to stay consistent with how every
  other edit affordance in this app already behaves (inline within the
  card, not a popup).
- Inside it: a status `<select>` (reuse the same four options used in
  `POST /api/projects`'s markup if you already added that in the last pass:
  on-track / at-risk / blocked / paused), a text input for target, a date
  input for target date, and a textarea for summary. Pre-fill all four from
  the current `init` values.
- On save: `PATCH /api/projects/${init.id}` with
  `{status, target, targetDate, summary}` through the existing `write()`
  helper (so it gets the "saved ✓" flash and rollback-on-failure behaviour
  everything else already has), then re-render and reopen the card
  (`render(); reopen(idx);`, the pattern already used everywhere else after
  a project-level write, e.g. around the Where We Are and Key Risk save
  handlers).
- On cancel: discard edits, close the panel, revert the fields to whatever
  `init` currently holds (not what was typed).
- Respect the read-only preview: if `isPreviewing()` is true, do not let the
  panel open at all, or if it's already open, block save with the same
  "Read-only preview, stop previewing to make changes." message the other
  forms already show (e.g. the new-project-form submit handler).

## Do not

- Introduce a framework or a build step. Still one HTML file, vanilla JS.
- Touch anything in `worker/`.
- Run any git command.
- Touch the existing Name or Where We Are edit controls, they're unrelated
  and already work.
- Show this panel's Edit button to a non-admin.
