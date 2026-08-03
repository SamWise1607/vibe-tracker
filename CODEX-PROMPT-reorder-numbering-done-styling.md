# Codex prompt: drag-to-reorder tasks, "1.1"-style task numbers, stronger done styling

Three changes to `public/index.html` only. The backend is already built,
deployed-ready, and tested (174/174 backend tests passing) — nothing here
should touch `worker/src/*.js`, `worker/schema.sql`, or `worker/seed.sql`.

Two backend pieces this depends on, already live in `worker/src/index.js`:

- `GET /api/state` now returns `number` on every task: a string like `"1.1"`
  or `"3.4"` (project number + the task's 1-based rank among the NOT-done
  tasks in that project), or `null` if the task's status is `'done'` (done
  tasks deliberately get no number at all).
- `PUT /api/projects/:id/tasks/reorder`, admin-only, body
  `{taskIds: [1,2,3,...]}` — the full list of that project's task ids, in
  the new order. Rejects (400) anything that isn't exactly a reordering of
  the project's existing tasks (missing one, extra one, or one from a
  different project). Rewrites `sort_order` to match; task numbers are
  recomputed live from that on the next read, nothing else to do.

---

## 1. Show the task number before the task name — and make it the drag handle

The number is both the visible "1.1" label AND the only thing you can grab
to reorder a task. The rest of the row (name, owner, status, due date,
notes) is not draggable, only that small span is. This is deliberate: it
keeps the row's normal click targets (the status dropdown, nudge/delete
buttons, note boxes) from fighting with drag gestures.

In the task-row render loop (`public/index.html`, search for
`class="task-name"`, currently around line 725):

```js
<tr class="${t.status === 'done' ? 'task-row-done' : ''}">
  <td class="task-name">${escapeHtml(t.name)}</td>
```

Change to:

```js
const canDrag = admin && !isPreviewing() && t.number;
const numberHtml = t.number
  ? `<span class="task-num"${canDrag ? ' draggable="true"' : ''}>${escapeHtml(t.number)}</span> `
  : '';
```
```js
<tr class="${t.status === 'done' ? 'task-row-done' : ''}" data-task-id="${t.id}">
  <td class="task-name">${numberHtml}${escapeHtml(t.name)}</td>
```

`data-task-id` on the `<tr>` is so the drop handler below can read real
database ids straight off the DOM without caring about `ti` (a render-time
array index that isn't stable across a reorder). A done task has no
`t.number`, so it renders no handle at all and can't be dragged — correct,
since its position no longer matters once it's sorted to the bottom.

CSS, near the other `.task-name` / `.tasks` table rules:

```css
.task-num{color:var(--text-dim);font-family:'IBM Plex Mono',monospace;font-size:12px;margin-right:2px;}
.task-num[draggable="true"]{cursor:grab;}
table.tasks tr.dragging{opacity:0.4;}
```

---

## 2. Drag-to-reorder (admin-only, one project's task list at a time)

The task rows are rendered inside each project's own `<tbody>` (search for
`<table class="tasks">`), one table per project card, so confining drags to
"one project at a time" falls out naturally if drop targets are only ever
other rows inside the *same* `<tbody>` the drag started in — don't build any
cross-tbody drop logic.

Add this near the other event-delegation wiring in the render/attach
function (search for where `[data-delete-task]` listeners get attached, this
belongs in the same place — it needs to re-run after every `render()` since
the rows are rebuilt each time):

```js
container.querySelectorAll('table.tasks tbody').forEach(tbody=>{
  let dragged = null;

  tbody.querySelectorAll('.task-num[draggable="true"]').forEach(handle=>{
    handle.addEventListener('dragstart', e=>{
      dragged = handle.closest('tr');
      dragged.classList.add('dragging');
      e.dataTransfer.setData('text/plain', ''); // some browsers require this to allow the drag
    });
    handle.addEventListener('dragend', ()=>{
      dragged?.classList.remove('dragging');
      dragged = null;
    });
  });

  tbody.addEventListener('dragover', e=>{
    if(!dragged) return;
    e.preventDefault();
    const target = e.target.closest('tr');
    if(!target || target === dragged || target.parentNode !== tbody) return;
    const rect = target.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    tbody.insertBefore(dragged, before ? target : target.nextSibling);
  });

  tbody.addEventListener('drop', async e=>{
    e.preventDefault();
    if(!dragged) return;

    // Cards are rendered in the same order as state.initiatives, and
    // reopen(idx) already relies on that (`document.querySelectorAll('.card')[idx]`).
    // Reuse the same positional lookup here rather than adding a new attribute.
    const card = tbody.closest('.card');
    const idx = Array.from(document.querySelectorAll('.card')).indexOf(card);
    const init = state.initiatives[idx];
    const newOrder = Array.from(tbody.querySelectorAll('tr[data-task-id]')).map(tr=>+tr.dataset.taskId);

    const before = init.tasks.slice();
    // Reorder the underlying array to match what's now on screen, so the
    // very next render() produces correct ti-indexed data attributes for
    // every control in these rows (status select, nudge, delete, notes).
    init.tasks = newOrder.map(id=>init.tasks.find(t=>t.id === id));
    render(); reopen(idx);

    await write(dragged, ()=>api(`/api/projects/${init.id}/tasks/reorder`, {method:'PUT', body:{taskIds:newOrder}}),
      ()=>{ init.tasks = before; render(); reopen(idx); });
  });
});
```

Notes for whoever implements this:

- `write()` and `isPreviewing()` are existing helpers in this file, reuse
  them, don't redefine.
- The drag *starts* only from the `.task-num` handle, but `dragged` is set
  to the whole `<tr>` (`handle.closest('tr')`) since that's the unit being
  moved and reordered — only the pickup gesture is restricted to the
  number, not what moves.
- Don't attempt to persist anything during `dragover`, only on `drop`. The
  live DOM reordering during `dragover` is just visual feedback.
- If the resulting `newOrder` is identical to what the project already had
  (a drag that ends up back where it started), it's fine to still fire the
  request; the backend treats a no-op reorder as valid.

---

## 3. Make the done-task grey-out actually noticeable

Sam's feedback on the current version (`tr.task-row-done{opacity:0.55;}`,
added by an earlier prompt): it's too subtle against the dark theme to read
as "done" at a glance. Strengthen it:

```css
tr.task-row-done{opacity:0.4;}
tr.task-row-done .task-name{text-decoration:line-through;color:var(--text-faint);}
```

Keep everything else about that row exactly as-is: still fully interactive
(status dropdown, nudge, delete, notes all still work), still sorted last
among that project's tasks. This is a values-only tweak to the existing
rule, not a restructure.

## Do not touch

- Backend files. All done on that side already.
- The done-task sort-to-bottom logic itself (the `order` array in the render
  loop) — unrelated to this prompt, already shipped and correct.
