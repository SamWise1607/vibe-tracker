# Codex prompt: note boxes should wrap, and a read-only "view as" for admins

Paste everything below the line into Codex, with `public/index.html` open.

The backend for both of these is already built and tested (140/140 passing),
not yet deployed. Do not change anything in `worker/`. This job is only
`public/index.html`.

---

## Fix 1: note boxes can't wrap

Each note box (`.task-note-box`, around line 105, built inside the note-render
helper around line 420) uses a single-line `<input>` for its text. An `<input>`
can never wrap no matter how wide the column is, so any note longer than the
box gets cut off with no way to read the rest.

Replace that `<input>` with a `<textarea>` that starts at one line tall and
grows to fit its content, the same idea as the existing "Where We Are"
edit box (`.wwa-edit`, textarea, around line 520 in the markup / bound around
line 727 in `bindCardEvents`). Concretely:

- Swap `<input value="...">` for `<textarea rows="1">...</textarea>` inside
  the note box markup (around line 421). Keep the same `data-task-note-edit`,
  `data-init`, `data-task`, `data-note-id` attributes, same save-on-change
  wiring at `[data-task-note-edit]` (around line 667), just adapt for a
  textarea instead of an input (e.g. `e.target.value` still works the same).
- Auto-grow it: on `input` (not just `change`), set
  `el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px';` so it
  expands as someone types past one line, and call the same sizing once on
  initial render so boxes with a long existing note already display multi-line
  on load, not just after you touch them.
- `.task-note-box` (line 105) uses `align-items:center`, which will look wrong
  once a box can be taller than one line. Change it to `align-items:flex-start`
  so the delete `×` button stays pinned to the top rather than vertically
  centering against a tall box.
- `.task-note-box input` styling (line 106-107) should move to
  `.task-note-box textarea`, plus add `resize:none;overflow:hidden;
  border:none;` so it doesn't show a native resize handle or scrollbar, it
  should only grow, never scroll internally.

## Fix 2: "view as" — a read-only preview of someone else's point of view

An admin can already tell what a member's account is limited to by reading
the code. Now they can also just look at it directly: pick a person, see
exactly what they would see, then step back out. Nobody's session changes and
nothing can be edited while previewing, this is a lens, not a login.

### The API

`GET /api/state` now optionally takes `?viewAs=<userId>` (admin-only, 403 for
anyone else). The response shape barely changes:

```jsonc
{
  "me": { "id": "sam", "name": "Sam", "role": "admin" },   // always the REAL signed-in user, never changes
  "viewingAs": null,                                        // or { "id": "mia", "name": "Mia", "role": "member" }
  // everything else (initiatives, tasks, ferdiDecisions, ...) is already
  // scoped and shaped exactly as it would be for viewingAs when it is set,
  // no client-side filtering needed
}
```

Unknown or inactive user id: 404. Non-admin attempting it: 403.

### What to build

**1. A "View as" picker, admin-only.** Add it next to the existing
"+ New Project" control in the `.projects-head` row (line 194-197), or its
own small row directly under the header, your call on placement, just keep
it visually distinct from the project controls so it doesn't read as
"create a project as someone." A `<select>` populated from the same roster
`GET /api/users` already gives you (active users only, exclude yourself,
there's nothing to preview about your own account), plus an explicit "Stop
previewing" control that only shows while a preview is active.

**2. Loading the preview.** On selecting someone, refetch state with the
query param: `api('/api/state?viewAs=' + encodeURIComponent(userId))`, replace
`state` with the result, re-render. "Stop previewing" refetches plain
`/api/state` (no query param) and re-renders.

**3. An unmissable banner while active.** Something like a full-width amber
or otherwise clearly-not-normal bar right under `<header>` (line 163), e.g.
"Viewing as Mia (member) — read-only · [Stop previewing]". This is the single
most important visual piece: someone glancing at the screen after switching
tabs needs to instantly know they're not looking at their own account.

**4. Make `isAdmin()` (line 237) reflect the previewed person, not the real
admin.** Right now it is:

```js
function isAdmin(){ return state?.me?.role === 'admin'; }
```

Change it to check `state.viewingAs` first when present:

```js
function isAdmin(){ return (state?.viewingAs?.role ?? state?.me?.role) === 'admin'; }
```

This is what makes the preview honest: every `admin?...` conditional already
in this file (owner-add controls, Key Risk edit, Nudge/Delete buttons, the
task name/due/owner-label fields being editable, the admin panel itself) will
now correctly show or hide exactly as it would for the person being previewed,
with zero other changes needed to those conditionals.

**5. `currentUser()` (line 238) should reflect the previewed person for
"My Tasks".** The "My Tasks" panel (`renderMyTasks`, around line 494) filters
by `currentUser().id`, and that is supposed to mean "the tasks belonging to
whoever's point of view we're showing." Change it to:

```js
function currentUser(){ return state?.viewingAs || state?.me || {id:'', name:'Me'}; }
```

**6. Make it actually read-only.** This is the part that matters most. While
`state.viewingAs` is set, no write should be possible, full stop, regardless
of what `isAdmin()` now returns. The simplest reliable approach: add one
guard at the top of `write()` (around line 310):

```js
async function write(control, request, rollback, after){
  if(state?.viewingAs){
    flashNote(control?.closest?.('.card')?.querySelector('.save-note') || document.querySelector('.save-note'),
      'Read-only preview, stop previewing to make changes.', true);
    return null;
  }
  // ...existing body unchanged
}
```

Since effectively every mutation in this app already goes through `write()`,
this alone blocks saves everywhere without having to hunt down and disable
every individual input, button and form. Additionally:

- Disable (not hide) task status/due/note inputs and the add-task/add-note/
  add-owner forms while `state.viewingAs` is set, e.g. add a
  `[disabled]` or a `pointer-events:none` class driven off
  `!!state.viewingAs` at render time, so it's visually obvious things are
  inert before someone even tries to click, not just rejected silently by
  `write()` after the fact.
- The "+ New Project" and "View as" controls themselves should still work
  normally even while previewing (an admin should be able to switch who
  they're previewing, or exit, without first exiting), just gate every
  other write.

### Do not

- Introduce a framework or a build step. Still one HTML file, vanilla JS.
- Touch anything in `worker/`.
- Run any git command.
- Build any way to actually act as the previewed person. If that ever gets
  asked for later, it is a separate, bigger feature with its own security
  questions, not an extension of this one.
- Let the banner be missable. If in doubt, make it more obvious, not less.
