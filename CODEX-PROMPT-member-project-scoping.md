# Codex prompt: disable the status control on tasks a member can see but not edit

Paste everything below the line into Codex, with `public/index.html` open.

The backend is already changed and tested (152/152 passing), already
deployed. Do not change anything in `worker/`. This job is only
`public/index.html`.

---

## What changed on the backend

`GET /api/state` used to filter a member down to only the individual tasks
they personally own, across every project. That's changed: a member now
sees a **project** at all only if they own at least one task on it. Once a
project is visible to them, they see **every task on it**, not just their
own.

```jsonc
// Before: Mia only ever saw tasks she owned, scattered across projects.
// Now: if Mia owns >=1 task on "fortress", she sees ALL of fortress's
// tasks in state.initiatives, including ones owned by Deoni, Elrine, etc.
// A project she owns zero tasks on (e.g. "vpic") does not appear for her
// at all, no card, nothing in state.initiatives.
```

Nothing about the shape of the response changed, no new fields. `t.owners`
is still an array on every task, same as before, that's how you tell who
actually owns a given task.

Editing permissions have **not** changed: a member can still only PATCH
`status` on a task they personally own (`PATCH /api/tasks/:id` still 403s
otherwise). What's new is that a member will now see tasks in the UI that
they are not allowed to edit, where before they simply never saw those
tasks at all.

## The problem this creates

The task-status `<select class="task-status">` (around line 714) renders
with no `disabled` attribute regardless of role or ownership. That was
fine before, because a member only ever saw tasks they owned. Now they'll
see tasks owned by other people too, and if they change that dropdown it
will hit a 403 (the existing `write()` rollback in the change handler,
line ~838, will revert it and flash an error, so nothing breaks, it's just
a bad experience: the control looks live but isn't).

The other per-task admin controls (owner add/remove, Nudge, Delete) are
already gated behind `admin?...` regardless of ownership, so they're
already correctly hidden for every member and need no change.

## What to build

In the task row template (the function that builds each `<tr>`, look for
`class="task-status"` around line 714), disable the status select when the
viewer is a member (`!isAdmin()`) and does not own that specific task:

```js
const ownsTask = (t.owners || []).some(o => o.id === currentUser().id);
const statusDisabled = (!admin && !ownsTask) ? 'disabled' : '';
```

(`admin` is already computed earlier in this render function as
`isAdmin()`, and `currentUser()` already exists at line 296, it returns
the previewed user when an admin is using "view as", the real signed-in
user otherwise, so this naturally also does the right thing during a
preview.)

Apply `${statusDisabled}` to the `<select class="task-status" ...>`
element itself. Give it a slightly muted look when disabled, consistent
with however the rest of the app already styles other disabled/read-only
inputs during "view as" previewing (search for how `isPreviewing()`
disables the note textareas at line 488, that's the existing pattern to
match, both mechanically and visually).

Do not add a tooltip, explanatory text, or any other new UI, just the
disabled state.

## Do not

- Introduce a framework or a build step. Still one HTML file, vanilla JS.
- Touch anything in `worker/`.
- Run any git command.
- Change the owner-add, Nudge, or Delete controls, they're already
  correctly admin-only regardless of ownership.
- Change how notes work. Notes stay open to any signed-in user on any
  task, unaffected by any of this.

## Known, deliberately out of scope

The due-date `<input type="date" class="task-due">` (line ~715) has the
same "looks editable, isn't" issue for members on tasks they own, since
members can only ever PATCH `status`, never `due`, even on their own
tasks. That bug predates this change and isn't part of this prompt, flag
it separately if you want it fixed.
