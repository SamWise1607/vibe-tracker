# Codex prompt: wire the VIBE dashboard to its API

Paste everything below the line into Codex, with `public/index.html` open.

The backend is already built, deployed and tested. Do not change anything in
`worker/`. This job is only `public/index.html`.

---

## Task

`public/index.html` is a working dashboard whose data layer is fake. It reads and
writes through `window.storage`, which is a Claude artifact API that does not exist
in a real browser, so nothing persists and every refresh resets it.

Replace the fake data layer with real API calls. Keep every visual decision exactly
as it is: the dark theme, the Space Grotesk / Inter / IBM Plex Mono type stack, the
card layout, the pulse line SVG, the panel structure, all of it. This is a rewiring
job, not a redesign.

## Fix these four bugs while you are in there

1. **Add Task is broken.** The `data-add-btn` click handler (near line 622)
   references `idx`, which is out of scope by then. It only existed inside the
   `forEach` callback that closed at line 515, so the handler throws a
   ReferenceError. Read it from the dataset inside the handler instead:
   `const idx = +btn.dataset.addBtn;` That is the pattern `data-add-owner-btn`
   already uses correctly.

2. **`paused` is missing from the task status dropdown.** `taskStatusOptions()`
   offers `not-started`, `in-progress`, `blocked`, `done`. But the seed data has a
   task with status `paused` (the VRES SA / Propcon one). No `<option>` matches, so
   the browser silently shows the first option and the task looks Not Started when
   it is actually parked. Add `paused` with the label "Paused". The database now
   accepts it.

3. **`escapeHtml` is applied to a number.** In `renderMyTasks`, `escapeHtml(i.projNum)`
   passes an integer. It works by accident. Pass the string or drop the call.

4. **The `.mt-status` span uses `status-${i.status}` classes** like `status-not-started`,
   but the CSS only defines `status-on-track`, `status-at-risk`, `status-blocked`
   and `status-paused`. Task statuses get no colour. Add CSS for the task status
   values, or map them.

## The API

Same origin, so all fetches are relative. Every request needs `credentials: 'include'`
so the session cookie travels. Every response is JSON.

### Reading

`GET /api/state` returns the whole app state in one call. Its shape is almost
identical to the old `seedData`, so most render functions need little change:

```jsonc
{
  "me": { "id": "sam", "name": "Sam", "email": "...", "role": "admin" },
  "focusThisWeek": "Fortress: finalise the distribution plan...",
  "leaderNotes": ["...", "...", "...", "..."],
  "lastEdited": { "by": "Deoni", "at": "2026-07-27" },
  "initiatives": [
    {
      "id": "fortress",
      "num": 1,
      "name": "Fortress Africa",
      "status": "at-risk",                       // on-track | at-risk | blocked | paused
      "owners": [ { "id": "deoni", "name": "Deoni" } ],   // CHANGED: objects, not strings
      "target": "Target: end Aug 2026 (King Price)",
      "targetDate": "2026-08-31",
      "summary": "...",
      "whereWeAre": "...",
      "keyRisk": ["...", "..."],
      "tasks": [
        {
          "id": 4,                               // NEW: real numeric id, use it for all writes
          "name": "Partner referral link build",
          "status": "in-progress",               // not-started | in-progress | blocked | paused | done
          "due": null,
          "note": "pending Briisk export format",
          "owners": [ { "id": "sam", "name": "Sam" } ],   // CHANGED: array of objects
          "ownerLabel": null                     // NEW: "Legal", "External (Discovery)", "Unassigned"
        }
      ]
    }
  ]
}
```

`GET /api/users` returns the roster for owner pickers. Admins additionally see
users with status `pending` or `rejected`.

### The three shape changes that matter

- **Project owners** were `["Deoni", "Sam"]`. They are now `[{id, name}]`.
- **Task owner** was a single string, sometimes `"Deoni / Mia"`. It is now
  `owners: [{id, name}]` plus a separate `ownerLabel` string for non-people.
  A task has human owners, or a label, or neither. Never both in practice.
- **Tasks have real ids.** Stop using array indices for writes.

The old free-text owner input must become a **multi-select picker** driven by
`GET /api/users`, with the non-person labels ("Unassigned", "Legal",
"External (Discovery)") as separate choices that set `ownerLabel` instead. You
cannot email a string, which is the whole reason this changed.

### Writing

| Action | Call |
|---|---|
| Edit Where We Are, status, target, summary | `PATCH /api/projects/:id` with any of `{status, target, targetDate, summary, whereWeAre}` |
| Edit Key Risk (admin only) | `PUT /api/projects/:id/risks` with `{risks: ["...", "..."]}` |
| Add project owner | `POST /api/projects/:id/owners` with `{userId}` — sends an email |
| Remove project owner | `DELETE /api/projects/:id/owners/:userId` |
| Add task | `POST /api/projects/:id/tasks` with `{name}`, returns `{id}` |
| Edit task | `PATCH /api/tasks/:id` with any of `{name, status, due, note, ownerLabel}` |
| Delete task | `DELETE /api/tasks/:id` |
| Set task owners | `PUT /api/tasks/:id/owners` with `{userIds: [], label: null}` — emails anyone newly added |
| **Nudge for an update** | `POST /api/tasks/:id/nudge` — returns `{sent: [names], skipped: [reasons]}` |
| Set this week's focus (admin) | `PUT /api/settings/focus` with `{value}` |
| Set leadership notes (admin) | `PUT /api/settings/leadership` with `{notes: []}` |
| Approve a join request (admin) | `POST /api/users/:id/approve` |
| Reject a join request (admin) | `POST /api/users/:id/reject` |
| Change someone's role (admin) | `PATCH /api/users/:id` with `{role: "admin"｜"member"}` |
| Sign out | `POST /api/auth/logout` |

## Replace the honour system with real auth

Delete the "Editing as" dropdown (`#whoami-select`) entirely. `currentUser()` now
comes from `state.me`. "My Tasks" filters on `state.me.id` matched against
`task.owners[].id`, not a substring match on a name.

Delete every `prompt('... Type DEONI ...')` gate. There are three: `#lock-toggle`,
`#focus-edit-btn`, and the per-project `data-risk-lock` buttons. Replace them with
`state.me.role === 'admin'`. If the user is not an admin, do not render the Edit
button at all rather than showing it and rejecting the click.

The server enforces all of this independently, so a member editing the DOM to
reveal a hidden button still gets a 403.

## Add a sign-in screen

If `GET /api/state` returns 401, render a sign-in view instead of the dashboard.
Match the existing dark theme.

- One email field and a "Send me a login link" button.
- On submit, `POST /api/auth/request` with `{email}`.
- Always show the same message the server returns, regardless of outcome:
  "If that address is recognised, check your inbox." Do not add your own
  "user not found" message. The uniform response is deliberate: it stops anyone
  probing which addresses are registered.
- If the URL contains `?error=invalid_link`, show "That link has expired or was
  already used. Request a new one." and clear the query string.

## Add a nudge button

On each task row, next to the status dropdown. Only visible to admins, and only
when the task has at least one human owner (`owners.length > 0`).

On click, `POST /api/tasks/:id/nudge` and show the outcome inline. The response is
`{sent: ["Elrine"], skipped: ["Mia (nudged in the last 24h)"]}`. Show both. The
rate limit is real and users need to see why nothing was sent, otherwise they will
click repeatedly.

Do not use `alert()`. Reuse the existing `.save-note` pattern that flashes
"saved ✓" and fades.

## Add an admin panel

Only for `state.me.role === 'admin'`. A collapsible section, styled like the
existing cards, listing users from `GET /api/users`:

- Pending users first, each with Approve and Reject buttons.
- Active users with a role toggle.
- Rejected users collapsed or greyed out.

Approving sends the person a login link automatically.

## Behaviour to keep exactly as it is

- Optimistic save with the "saved ✓" flash. Do not add spinners.
- Cards stay open after an edit. The current code re-renders and then re-adds the
  `.open` class. Keep that.
- The pulse line colour thresholds and the `statusWeight` calculation.
- "Decisions Needed from Ferdi" is derived, not stored. Keep deriving it, but match
  on `owners[].id === 'ferdi'` rather than a substring of the owner string.
- The days-left badge and its ok / soon / overdue thresholds.
- The footer text.

## Error handling

Wrap every write. If a call fails, show the error inline near the control and
revert the optimistic UI change. Never leave the screen showing a value the server
rejected. A 401 on any call means the session expired: re-render the sign-in view.

## Do not

- Introduce a framework or a build step. It stays one HTML file with vanilla JS.
- Add any dependency beyond the Google Fonts link already there.
- Use `localStorage` or `sessionStorage` for app data. The session cookie is
  HttpOnly and handled by the browser.
- Touch anything in `worker/`.
- Run any git command.
