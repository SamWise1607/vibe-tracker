# Codex prompt: fix note textareas rendering with zero height

Paste everything below the line into Codex, with `public/index.html` open.

This is a pure CSS/JS bug, confirmed by reading the code and by checking
the real data in D1 (the text genuinely exists in the database, this is
not a data problem). Do not change anything in `worker/`, no backend
involved at all.

---

## The bug

Task note boxes render with their border and delete "×" button visible,
but no text inside, on every task, everywhere.

The text is actually there. The textarea holding it is being pinned to
0px tall before it's ever shown, so the text is present in the DOM but
clipped out of view.

## Root cause

`growNoteTextarea()` (around line 504) does:

```js
function growNoteTextarea(el){
  if(!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
```

It's called once per note textarea right after `render()` builds the
page (around line 840-842):

```js
container.querySelectorAll('[data-task-note-edit]').forEach(inp=>{
  growNoteTextarea(inp);
  inp.addEventListener('input', e=>growNoteTextarea(e.target));
});
```

Cards start collapsed: `.card-body{display:none;}`, only becoming
`display:block` once `.card` also has the `open` class (line 85-86).
`render()` rebuilds the entire cards HTML from scratch on every call and
does not carry the `open` class over, a separate helper (`reopen(idx)`,
line 417) re-adds it afterward wherever needed. But `growNoteTextarea`
runs as part of `render()`, before `reopen()` gets a chance to run. A
`display:none` element always reports `scrollHeight` of 0, so every note
textarea gets `height: 0px` set on it while its card is still collapsed,
and nothing ever recalculates that height once the card actually becomes
visible. The 0px height persists, the value/text inside is untouched and
correct, it's just invisible.

## The fix

Re-run `growNoteTextarea` on a card's note boxes at the moment that card
actually becomes visible, in both places a card can become visible:

1. **`reopen(idx)`** (line 417-420), used after most write operations to
   restore the open state on the card that was just edited:

```js
function reopen(idx){
  const card = document.querySelectorAll('.card')[idx];
  if(card){
    card.classList.add('open');
    card.querySelectorAll('[data-task-note-edit]').forEach(growNoteTextarea);
  }
}
```

2. **The manual expand/collapse click handler** (search for
   `card.querySelector('.card-head').addEventListener('click'`, around
   line 746), which toggles `.open` when a person clicks a card header:

```js
card.querySelector('.card-head').addEventListener('click', ()=>{
  card.classList.toggle('open');
  if(card.classList.contains('open')){
    card.querySelectorAll('[data-task-note-edit]').forEach(growNoteTextarea);
  }
});
```

Both changes are small and mechanical. `growNoteTextarea` itself does not
need to change, it works correctly once called while the element is
actually laid out (i.e., not inside a `display:none` ancestor).

## How to verify it worked

After the fix, open a card that has tasks with existing notes (Fortress,
task "Partner referral link build on Fortress site" has one, for
example). The note text should be visible immediately on open, not just
after clicking into the box.

## Do not

- Introduce a framework or a build step. Still one HTML file, vanilla JS.
- Touch anything in `worker/`.
- Run any git command.
- Change how notes are added, edited, or deleted, only the height-on-open
  behaviour.
