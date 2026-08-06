# Codex prompt: header logo + favicon

File to edit: `public/index.html`. Nothing else.

Four new image files already exist in `public/` (already added, do not recreate them): `logo-header.png`, `favicon-16.png`, `favicon-32.png`, `favicon-180.png`. All four have transparent backgrounds already keyed to match the app's `--ink` (`#14171c`) colour, so they sit cleanly on the dark theme with no visible edge box.

## 1. Favicon

In `<head>`, after the existing `<title>VIBE Tracker</title>` line, add:

```html
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="favicon-180.png">
```

## 2. Header logo

Find the header markup (currently a single line):

```html
<header>
  <div class="brand">VIBE <span class="tag">Vision Innovation &amp; Business Evolution</span><button class="lock-btn" id="sign-out-btn" style="margin-left:auto;">Sign out</button></div>
  <div class="sub">Live operations tracker — 6 projects, shared across the team</div>
</header>
```

Replace the `.brand` div's contents with the logo image (the image already contains the "VIBE" wordmark and the "Vision Innovation & Business Evolution" tagline baked in, so both the bare "VIBE" text and the `<span class="tag">` go away, that's deliberate, not an oversight):

```html
<header>
  <div class="brand">
    <img src="logo-header.png" alt="VIBE Tracker — Vision Innovation & Business Evolution" style="height:110px;width:auto;display:block;">
    <button class="lock-btn" id="sign-out-btn" style="margin-left:auto;">Sign out</button>
  </div>
  <div class="sub">Live operations tracker — 6 projects, shared across the team</div>
</header>
```

Keep `id="sign-out-btn"` exactly as-is, the sign-out click handler is wired to that id elsewhere in the file and must not be touched or renamed.

## 3. One CSS tweak

Find `.brand` in the `<style>` block:

```css
.brand{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:36px;letter-spacing:0.5px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}
```

Change `align-items:baseline` to `align-items:center`. Reason: `baseline` alignment made sense for two lines of text of similar size, but now the row holds a 110px-tall image next to a small button, and baseline alignment would put them at visually mismatched heights. `center` fixes that. Nothing else in this rule changes.

## Do not

- Do not touch anything in `worker/` or `email.js`. This is a frontend-only, cosmetic change, the email templates deliberately do not get a logo (Sam's explicit call, plain "VIBE Tracker" text stays in emails).
- Do not resize, re-crop, or regenerate the four PNG files, they're already sized correctly for their use (`logo-header.png` at its native cropped size for the `height:110px` display size, the three favicon sizes are standard 16/32/180 already).
- Do not add a `manifest.json` or PWA icon entries, out of scope for this change.
