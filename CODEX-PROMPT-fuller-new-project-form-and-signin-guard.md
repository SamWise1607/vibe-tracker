# Codex prompt: full New Project form, and grey out the sign-in button after one click

Paste everything below the line into Codex, with `public/index.html` open.

Both of these are frontend-only. `worker/` already supports everything
needed, nothing to deploy on the backend side, no D1 changes.

---

## Fix 1: "New Project" only asks for a name, should ask for everything

`POST /api/projects` (used by the submit handler around line 1179) already
accepts `{name, status, target, targetDate, summary, whereWeAre}`, all
optional except `name`. The form only sends `name` right now, so a new
project is created with defaults for everything else, then there's currently
no way to change status, target, target date or summary afterward from the
UI at all (only the project's name and Where We Are have edit controls, see
the "known related gap" note at the bottom, do not try to fix that here, it's
a separate, later task).

Expand the form (currently lines 218-225) from the single name field into
one covering all of it:

```html
<div class="new-project-row" id="new-project-row">
  <form id="new-project-form">
    <label>Name
      <input type="text" id="new-project-name" required placeholder="Project name...">
    </label>
    <label>Status
      <select id="new-project-status">
        <option value="on-track">On track</option>
        <option value="at-risk">At risk</option>
        <option value="blocked">Blocked</option>
        <option value="paused">Paused</option>
      </select>
    </label>
    <label>Target
      <input type="text" id="new-project-target" placeholder="e.g. Target: end Aug 2026 (King Price)">
    </label>
    <label>Target date
      <input type="date" id="new-project-target-date">
    </label>
    <label class="task-note-field">Summary
      <textarea id="new-project-summary" rows="2" placeholder="What this project is..."></textarea>
    </label>
    <label class="task-note-field">Where We Are
      <textarea id="new-project-where" rows="2" placeholder="Current state..."></textarea>
    </label>
    <div class="task-form-actions">
      <button type="submit" class="lock-btn">Create</button>
      <button type="button" class="lock-btn" id="new-project-cancel">Cancel</button>
    </div>
    <div class="save-note" id="new-project-note"></div>
  </form>
</div>
```

The exact markup/classes above are a starting point, use your judgement to
match the visual language already established by `.add-task-row`'s `<label>`
+ stacked-field layout (around line 664 onward) rather than the current
single-row flex layout in `.new-project-row` (line 143-146 in the CSS),
five-plus fields side by side would not be readable. Reusing
`.task-note-field` for the two textareas (it's already styled to span the
full row width) is a reasonable shortcut, or write dedicated styling if you
prefer, your call.

Update the submit handler (currently around line 1179-1201) to collect and
send everything:

```js
document.getElementById('new-project-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const form = e.target;
  const note = document.getElementById('new-project-note');
  const name = document.getElementById('new-project-name').value.trim();
  if(!name) return;
  if(isPreviewing()){
    flashNote(note, 'Read-only preview, stop previewing to make changes.', true);
    return;
  }
  const body = {
    name,
    status: document.getElementById('new-project-status').value,
    target: document.getElementById('new-project-target').value.trim(),
    targetDate: document.getElementById('new-project-target-date').value || null,
    summary: document.getElementById('new-project-summary').value.trim(),
    whereWeAre: document.getElementById('new-project-where').value.trim(),
  };
  try{
    await api('/api/projects', {method:'POST', body});
    form.reset();
    await loadState();
    const row = document.getElementById('new-project-row');
    row.classList.add('open');
    flashNote(document.getElementById('new-project-note'), 'saved');
    setTimeout(()=>row.classList.remove('open'), 1500);
  }catch(err){
    if(err.status !== 401) flashNote(note, err.message, true);
  }
});
```

Leave everything else about how the form opens/closes/cancels (lines
1165-1177) as-is, just make sure `Cancel` and the reset-after-success path
also clear the new fields, not just the name.

### Known related gap, do not fix it here

Once a project is created with a status/target/summary, there is currently
no way to edit any of those three afterward from the UI (only the project
name and "Where We Are" have an edit control). That's a real gap but it's
its own decision (a dropdown next to the status pill? one combined "Edit
details" panel? inline like Where We Are, three separate buttons?), flagged
to Sam separately, not part of this prompt.

## Fix 2: sign-in button can be clicked repeatedly before the request resolves

This was flagged as a known bug in `DNS-QUESTIONS-FOR-IT.md`: clicking "Send
me a login link" once was observed sending three requests in under a second,
wasting the email-sending quota (200/month on the shared plan). The button
has no guard at all right now (`renderSignIn`, submit handler around lines
1221-1231).

Disable it the moment it's clicked, and grey it out, so a double-click or
repeated tapping cannot fire more than one request:

```js
document.getElementById('signin-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  if(btn.disabled) return;
  const email = document.getElementById('signin-email').value.trim();
  const msg = document.getElementById('signin-message');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try{
    const res = await api('/api/auth/request', {method:'POST', body:{email}});
    msg.textContent = res.message || 'If that address is recognised, check your inbox.';
    btn.textContent = 'Link sent';
    // stays disabled: the whole point is one request per page load, if they
    // need another link they can refresh
  }catch(err){
    if(err.status !== 401) msg.textContent = 'If that address is recognised, check your inbox.';
    // a genuine failure (e.g. network error) should let them try again,
    // rather than permanently locking the button until a refresh
    btn.disabled = false;
    btn.textContent = 'Send me a login link';
  }
});
```

Add basic disabled styling if there isn't any already (check whether
`button:disabled` or `.lock-btn:disabled` has a rule; if not, a simple
`opacity:0.5;cursor:not-allowed;` on `button:disabled` is enough, this
button doesn't currently use the `.lock-btn` class so check its own
selector in the `<style>` block).

### Do not

- Introduce a framework or a build step. Still one HTML file, vanilla JS.
- Touch anything in `worker/`.
- Run any git command.
- Build editing for project status/target/summary in this pass, see the
  "known related gap" note above.
