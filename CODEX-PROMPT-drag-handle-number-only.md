# Codex prompt: restrict the task drag handle to the number, not the whole row

Follow-up to the drag-to-reorder feature already deployed (whole row is
currently draggable). Sam wants the drag handle to be just the "1.1"-style
number, not the entire row — the rest of the row (name, owner, status,
due date, notes) should go back to click-only, no drag.

`public/index.html` only, three small edits.

---

## 1. Move `draggable` off the `<tr>`, onto the number span

Currently (around line 728-729):

```js
<tr class="${t.status === 'done' ? 'task-row-done' : ''}" data-task-id="${t.id}" ${admin && !isPreviewing() ? 'draggable="true"' : ''}>
  <td class="task-name">${t.number ? `<span class="task-num">${escapeHtml(t.number)}</span> ` : ''}${escapeHtml(t.name)}</td>
```

Change to:

```js
<tr class="${t.status === 'done' ? 'task-row-done' : ''}" data-task-id="${t.id}">
  <td class="task-name">${t.number ? `<span class="task-num"${admin && !isPreviewing() ? ' draggable="true"' : ''}>${escapeHtml(t.number)}</span> ` : ''}${escapeHtml(t.name)}</td>
```

Keep `data-task-id` on the `<tr>` — the drop handler in step 3 still reads
task order off that. Only the `draggable` attribute moves. A done task has
no `t.number`, so it renders no handle and stays undraggable, unchanged.

---

## 2. CSS: move the grab cursor to the handle

Currently (around line 103):

```css
table.tasks tr[draggable="true"]{cursor:grab;}
```

Change to:

```css
.task-num[draggable="true"]{cursor:grab;}
```

Leave `table.tasks tr.dragging{opacity:0.4;}` (or wherever the dragging-state
rule ended up) as-is — that still applies to the row being moved, just the
grab cursor affordance is now on the handle instead of the whole row.

---

## 3. JS: attach dragstart/dragend to the handle, not the row

Currently (search for `container.querySelectorAll('table.tasks tbody')`,
around line 1020):

```js
tbody.querySelectorAll('tr[draggable="true"]').forEach(row=>{
  row.addEventListener('dragstart', ()=>{
    dragged = row;
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', ()=>{
    row.classList.remove('dragging');
    dragged = null;
  });
});
```

Change to:

```js
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
```

`dragged` is still the whole `<tr>` (via `handle.closest('tr')`) since that's
still the unit that moves and gets reordered — only the pickup gesture is
now restricted to the number. The `dragover` and `drop` listeners on `tbody`
right after this block are unaffected, don't change them.

## Do not touch

- Everything else about drag-to-reorder (the `dragover`/`drop` logic, the
  `PUT /api/projects/:id/tasks/reorder` call, the optimistic
  reorder-then-rollback-on-failure behavior) — already correct, this prompt
  only changes *where you can start a drag from*.
- Task numbering, done-task styling, backend — untouched by this change.
