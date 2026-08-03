# Codex prompt: done tasks sort to bottom + grey out, notes fold in newest-first

Two small, unrelated frontend-only changes to `public/index.html`. Backend
work for the notes-ordering half is already done and deployed-ready
(`worker/src/index.js` now returns notes newest-first); this prompt is only
the matching frontend half plus the completely separate done-task styling.

---

## 1. Done tasks sink to the bottom of the task table and grey out

Find the task-row render loop (currently around line 714):

```js
${(init.tasks || []).map((t,ti)=>{
  const ownsTask = (t.owners || []).some(o=>o.id === currentUser().id);
  const statusDisabled = (!admin && !ownsTask) ? 'disabled' : '';
  return `
  <tr>
    <td class="task-name">${escapeHtml(t.name)}</td>
    ...
  </tr>
`}).join('')}
```

Every `data-*="${ti}"` attribute in that row (and there are several: the
status select, nudge/delete buttons, owner add/remove controls, the due-date
input, the note boxes) is keyed off `ti`, the task's index in
`init.tasks`. Any fix must keep `ti` as the task's real index into
`init.tasks` — only the *order the rows are printed in* should change, not
what `ti` means. So: don't sort `init.tasks` itself or build a filtered
copy. Instead, sort an array of indices and iterate that:

```js
${(() => {
  const tasks = init.tasks || [];
  // Stable sort: not-done tasks first (in their existing order), done tasks
  // last (in their existing order among themselves).
  const order = tasks.map((_, ti) => ti)
    .sort((a, b) => (tasks[a].status === 'done' ? 1 : 0) - (tasks[b].status === 'done' ? 1 : 0));
  return order.map(ti => {
    const t = tasks[ti];
    const ownsTask = (t.owners || []).some(o=>o.id === currentUser().id);
    const statusDisabled = (!admin && !ownsTask) ? 'disabled' : '';
    return `
    <tr class="${t.status === 'done' ? 'task-row-done' : ''}">
      <td class="task-name">${escapeHtml(t.name)}</td>
      ... (rest of the row body, unchanged)
    </tr>
  `}).join('');
})()}
```

Array.prototype.sort has been stable since ES2019 (all evergreen browsers),
so ties keep their original relative order — this just moves the done ones
down, it doesn't otherwise reshuffle the list.

Add a CSS rule for the grey-out, following the existing precedent for
`.rejected{opacity:0.55;}` (used elsewhere in this file for the same "still
there, visually de-emphasized" effect):

```css
tr.task-row-done{opacity:0.55;}
```

Put it near the other `.tasks` table rules (search for `select.task-status`
or `.nudge-btn` to find that block). Don't add `text-decoration:line-through`
or hide any controls — the row should stay fully interactive (status
dropdown, nudge, delete, notes all still work), just visually dimmed and
sorted last.

---

## 2. New notes fold in above older ones, not below

The backend (`GET /api/state`) now returns each task's `notes` array
newest-first (it used to be oldest-first / append order). The frontend
renders notes in whatever order the `notes` array is in, so no render-code
change is needed there — but the *optimistic* local update when adding a
note still appends to the end, which would show the new note at the bottom
for a moment before jumping to the top once the real state re-renders.

Find this (currently around line 891-901, inside the
`data-add-note-btn` click handler):

```js
const tempNote = {id:`temp-${Date.now()}`, text};
task.notes.push(tempNote);
```

Change `push` to `unshift` so the optimistic placement matches where it will
actually land:

```js
const tempNote = {id:`temp-${Date.now()}`, text};
task.notes.unshift(tempNote);
```

That's the only line that needs to change for this half. Everything else in
that handler (the `write()` call, the temp-id patch-up, the delete/edit
handlers) is unaffected since they look up notes by id, not position.

---

## Do not touch

- Backend files (`worker/src/*.js`, `worker/schema.sql`, `worker/seed.sql`) —
  already done on that side.
- Anything about how notes are *stored* (`sort_order` still increments on
  insert as before) — this is purely a display-order + optimistic-UI fix.
