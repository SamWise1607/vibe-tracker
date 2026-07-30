# Codex prompt: new projects, project rename, and multi-box notes

Paste everything below the line into Codex, with `public/index.html` open.

The backend is already built and tested (132/132 passing), but **not yet
deployed**. Do not change anything in `worker/`. This job is only
`public/index.html`.

---

## Task

Two features, both already fully working on the backend:

1. **Admins can create a new project and rename an existing one.** Neither was
   possible before today. There is no milestones concept and there won't be,
   projects are still just name + status + target + summary + Where We Are.
2. **Task notes are now multiple boxes, not one field.** A task can carry
   several free-text notes, each added, edited and deleted independently.
   Any signed-in user can add/edit/delete a note on any task, regardless of
   who owns it, so do not gate this behind `isAdmin()` or task ownership.
   Notes are plain: no author name or timestamp shown on a box, and no undo
   once deleted.

## The API (what changed)

### Projects

| Action | Call | Who |
|---|---|---|
| Create a project | `POST /api/projects` with `{name, status?, target?, targetDate?, summary?, whereWeAre?}`, returns `{id}` | Admin only, 403 otherwise |
| Rename a project | `PATCH /api/projects/:id` with `{name}` (can combine with the existing fields in one call) | Admin only, 403 otherwise |

`status` defaults to `on-track` if omitted or invalid. The `id` is
slugified from the name server-side (`"Fortress Africa"` → `"fortress"`,
collisions get `-2`, `-3`, ...), you never send or choose the id yourself.
A blank name is rejected with 400 on both create and rename.

### Task notes

Notes moved off `PATCH /api/tasks/:id` entirely. **`note` is no longer a
field on that endpoint** and no longer appears in the `GET /api/state`
task shape. In its place:

```jsonc
// GET /api/state, inside a task:
{
  "id": 4,
  "name": "...",
  "notes": [ { "id": 15, "text": "pending Briisk export format" } ],  // NEW, replaces the old single "note" string
  // ...owners, ownerLabel, status, due as before
}
```

| Action | Call |
|---|---|
| Add a note box | `POST /api/tasks/:id/notes` with `{text}`, returns `{id}` |
| Edit a note box | `PATCH /api/tasks/:id/notes/:noteId` with `{text}` |
| Delete a note box | `DELETE /api/tasks/:id/notes/:noteId` |

All three are open to any signed-in user, no admin check, no ownership
check. Blank text is rejected with 400. A missing task or note id 404s.

The "Add task" form's optional note field still exists and still works
exactly the same from the user's point of view, it just becomes the new
task's first note box server-side (`POST /api/projects/:id/tasks` still
accepts an optional `note` string in the body, unchanged).

## What to build

### 1. A "+ New Project" control

Admin-only, matching the `.lock-btn` pattern already used for "Edit
(Admins only)" elsewhere (e.g. the Leadership Flags header, line ~168).
Place it just above `<div id="cards"></div>` (line 179), something like a
small header row: "Projects" on the left, the button on the right.

Clicking it opens a small inline form (reuse the same open/close toggle
pattern as `.add-task-row` / `data-add-task-toggle`, not a native
`prompt()`), asking for at minimum a Name field. Status/target/summary can
be left to edit afterwards via the fields that already exist on the card,
you do not need to build all of them into the creation form.

On submit: `POST /api/projects` with `{name}`, then reload state (`await
loadState()` is simplest, this is a rare action, an extra full reload of
`/api/state` is fine here rather than trying to splice the new project into
`state.initiatives` by hand). Show the same `.save-note` "saved ✓" flash
pattern on success, and the same inline error display on failure that
`write()` already gives everything else.

### 2. Renaming a project

Reuse the existing "Where We Are" inline-edit pattern (`data-wwa-toggle`,
lines 501-506, 653-666): a ✎ Edit button next to `.card-title` that swaps
the `<span class="card-title">` for a text input, then on save calls
`PATCH /api/projects/:id` with `{name}` through the existing `write()`
helper. Admin-only, do not render the edit button at all for a non-admin
(the server enforces it too, but per the existing convention in this app,
hidden controls should actually be hidden, not just rejected on click).

### 3. Notes column: stacked boxes, not one input

Replace the current single `<input class="task-note">` per task row
(line 532, and its `change` handler at lines 576-582) with:

- Each existing note in `t.notes` rendered as its own small box/pill inside
  the Notes `<td>`, stacked vertically. Click into a box to edit its text
  inline (same "click to edit, blur or Enter to save" affordance the rest
  of the app already uses elsewhere is fine, use your judgement on the
  exact interaction, just keep it consistent with the app's existing
  editing patterns rather than inventing a new one). A small "×" to delete
  the box, same visual weight as the existing `owners-chip` remove button
  (line 492) or the nudge/delete task buttons (line 530).
- A small "+ add note" control below the stack of boxes that reveals a
  one-line input; submitting it calls `POST /api/tasks/:id/notes` and adds
  a new box, then clears the input so another note can be added right
  after (this is the "add a new box in the notes column" behaviour asked
  for, it should not close or collapse after each add).
- No author name or timestamp on a box. This was a deliberate choice, do
  not add it back in.
- The Notes column may need to grow taller/wider than it currently is to
  hold more than one box comfortably. Use your judgement, the existing
  `.task-col-note` colgroup entry (line 522) is the place to adjust width;
  height is naturally driven by content, do not fix it.

Wire the add/edit/delete actions the same way every other write in this
app is wired: through `write()` for the optimistic-save flash and rollback
behaviour, and `api()` for the actual fetch. Look at how
`[data-remove-task-owner]` (line 615) or `[data-add-task-owner-btn]` (line
591) are bound for the closest existing pattern of "small control inside a
task row that mutates one thing and re-renders."

### 4. `normalizeState`

Add a defensive default in `normalizeState` (around line 269): if a task
somehow arrives without a `notes` array (stale cache, older API response
during a rollout), default it to `[]` rather than letting the renderer
throw on `t.notes.map(...)`. Something like:

```js
if(!Array.isArray(t.notes)) t.notes = [];
```

## Do not

- Introduce a framework or a build step. Still one HTML file, vanilla JS.
- Touch anything in `worker/`.
- Run any git command.
- Add author names or timestamps to note boxes.
- Let a non-admin see the "+ New Project" button or a project rename
  control, even though the server also enforces both.
