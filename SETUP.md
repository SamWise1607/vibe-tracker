# VIBE Tracker: Setup

Everything here you run yourself. Nothing has been deployed and no git commands have been run.

Work through it in order. Parts 1 and 2 are account setup with no code. Part 3 is the deploy.

---

## What exists right now

```
vibe-tracker/
  public/
    index.html          the draft, unchanged. Codex rewires this (see CODEX-PROMPT.md)
  worker/
    src/
      index.js          the API
      auth.js           magic link login
      email.js          all email sending, isolated in one file
    test/
      run.mjs           80 tests, all passing
      harness.mjs       fake D1 + fake email so tests need no accounts
    tools/
      make-seed.js      regenerates seed.sql from the draft HTML
    schema.sql          database structure
    seed.sql            your 6 projects, 36 tasks, 6 people
    wrangler.toml       Cloudflare config (two placeholders to fill in)
    package.json
```

Run the tests any time with:

```bash
cd worker
npm install
npm test
```

That needs no accounts, no internet and no keys. If it passes, the backend logic is sound.

---

## Part 1: EmailJS (about 10 minutes)

This is what replaced the DNS/SPF/DKIM problem. EmailJS sends through an existing
mailbox instead of sending as a domain, so there is nothing to verify.

1. Sign up at https://www.emailjs.com (free plan).

2. **Add an email service.** Dashboard, then Email Services, then Add New Service.
   Pick Gmail or Outlook depending on what `sam@visionbrokers.co.za` runs on, and
   click through the OAuth approval. Emails will send from that mailbox and will
   appear in its Sent folder.

   Copy the **Service ID** it shows you.

3. **Create one email template.** Email Templates, then Create New Template.

   Set the "To Email" field to `{{to_email}}` and the Subject to `{{subject}}`.

   For the content, switch to the code editor and paste:

   ```html
   <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1b1f27;">
     <h2 style="font-size:19px;margin:0 0 14px;">{{heading}}</h2>
     <p style="font-size:15px;line-height:1.6;white-space:pre-line;margin:0 0 22px;">{{body}}</p>
     <a href="{{cta_url}}"
        style="display:inline-block;background:#2a9686;color:#fff;text-decoration:none;
               padding:11px 22px;border-radius:6px;font-weight:600;font-size:15px;">
       {{cta_label}}
     </a>
     <p style="font-size:12px;color:#8f97a8;margin-top:28px;">
       Sent by the VIBE operations tracker.
     </p>
   </div>
   ```

   Save, then copy the **Template ID**.

   One template covers all four email types (login link, added to project, task
   assigned, nudge). The free plan allows two, so there is one spare.

4. **Get both keys.** Account, then General.
   Copy the **Public Key** and the **Private Key**.

   The private key is the one that matters. It is what lets the Worker send
   server-side, which is what keeps login tokens out of the browser. Treat it
   like a password. It never goes in a file, only into `wrangler secret`.

You should now have four values written down: Service ID, Template ID, Public Key, Private Key.

---

## Part 2: Cloudflare (about 5 minutes)

1. Sign up at https://dash.cloudflare.com (free). No credit card needed.

2. In your terminal:

   ```bash
   cd vibe-tracker/worker
   npm install
   npx wrangler login
   ```

   That opens a browser to authorise. Approve it.

3. Create the database:

   ```bash
   npx wrangler d1 create vibe-tracker
   ```

   It prints a block ending in `database_id = "..."`. **Copy that ID.**

4. Open `worker/wrangler.toml` and replace `PASTE_YOUR_DATABASE_ID_HERE` with it.

   Leave `APP_URL` for now. You need the deployed URL first, and you get that in Part 3.

---

## Part 3: Deploy

Run these one at a time. Read what each prints before running the next.

**Create the tables:**

```bash
npx wrangler d1 execute vibe-tracker --file=./schema.sql --remote
```

**Load your six projects:**

```bash
npx wrangler d1 execute vibe-tracker --file=./seed.sql --remote
```

Check it worked:

```bash
npx wrangler d1 execute vibe-tracker --remote --command "SELECT num, name, status FROM projects ORDER BY num"
```

You should see all six, from Fortress Africa down to VRES Namibia.

**Set the four secrets.** Each prompts for the value, paste and press enter:

```bash
npx wrangler secret put EMAILJS_SERVICE_ID
npx wrangler secret put EMAILJS_TEMPLATE_ID
npx wrangler secret put EMAILJS_PUBLIC_KEY
npx wrangler secret put EMAILJS_PRIVATE_KEY
```

**Deploy:**

```bash
npx wrangler deploy
```

It prints your live URL, something like `https://vibe-tracker.samgerber.workers.dev`.

**Now go back and fix APP_URL.** Open `wrangler.toml`, set `APP_URL` to that exact
URL with no trailing slash, then deploy again:

```bash
npx wrangler deploy
```

This step is not optional. Magic links are built from `APP_URL`, so if it is wrong
or still the placeholder, every login link in every email points at nothing.

---

## Part 4: First sign-in

1. Open your live URL.
2. Enter `sam@visionbrokers.co.za`.
3. Check your inbox. Click the link. You should land signed in as an admin.

If no email arrives, check the EmailJS dashboard under Email History. It logs every
attempt with the failure reason, which is faster than guessing.

Once you are in and it works, tell the other five to go to the URL and enter their
work address. They already exist as active users, so they get a login link straight
away with nothing to approve.

Anyone who is *not* one of the six gets a pending account instead, and you, Ferdi
and Deoni get an email about it. Nobody gets in without one of you approving.

---

## Running it locally while you work on the UI

```bash
cd worker
npx wrangler d1 execute vibe-tracker --file=./schema.sql --local
npx wrangler d1 execute vibe-tracker --file=./seed.sql --local
npx wrangler dev
```

That serves on `http://localhost:8787` with a local copy of the database, so you
can break things freely without touching live data.

For local email, create `worker/.dev.vars` (already gitignored):

```
EMAILJS_SERVICE_ID=...
EMAILJS_TEMPLATE_ID=...
EMAILJS_PUBLIC_KEY=...
EMAILJS_PRIVATE_KEY=...
APP_URL=http://localhost:8787
```

Note that local magic links only work if `APP_URL` points at localhost. Also note
that local testing burns real emails against your 200/month allowance, so lean on
`npm test` instead where you can.

---

## Git

No git commands have been run for you. When you are ready:

```bash
cd vibe-tracker
git init
git add .
git commit -m "VIBE tracker: worker API, D1 schema, seed data, tests"
```

Then create an empty repo on GitHub and follow the two commands it gives you to
push. Check `git status` before committing and confirm `node_modules/`, `.wrangler/`
and `.dev.vars` are not in the list. The `.gitignore` handles that, but look anyway.

---

## Watch your email budget

EmailJS free is **200 emails/month, 100/day**. Rough usage at six people:

| Email type | Estimate |
|---|---|
| Login links (30-day sessions) | 10 to 20 |
| Added to project or task | 20 to 40 |
| Nudges | 30 to 60 |
| Join requests | a handful |
| **Total** | **roughly 60 to 130** |

Comfortable, but not unlimited. Two things already protect it: nudges are rate
limited to once per person per task per 24 hours, and nobody is ever emailed about
their own action.

If you outgrow it, everything sending lives in `src/email.js` in a single
`sendEmail()` function. Swapping to Resend means rewriting that one function and
doing the DNS setup, which will be far less painful on a subdomain like
`mail.visionbrokers.co.za` since it has no existing records to conflict with.

---

## Known gaps

- The UI in `public/index.html` is still the draft and is not wired to the API yet.
  See `CODEX-PROMPT.md`.
- No milestones. Deliberately deferred.
- No automatic stale-task reminders or weekly digest. Both become easy once you
  want them, since Cloudflare Cron Triggers are free.
- No reply-by-email updates.
- No admin "view as" toggle, so Deoni cannot preview someone else's view.
