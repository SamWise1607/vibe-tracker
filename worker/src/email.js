/**
 * Email layer.
 *
 * Everything the app sends goes through sendEmail() below. That is deliberate:
 * EmailJS free is 200 emails/month, and if VIBE outgrows it, swapping to Resend
 * means rewriting this one function and nothing else.
 *
 * WHY SERVER-SIDE: EmailJS is normally called from the browser with a public
 * key. That is fine for a contact form and catastrophic for magic links, since
 * the browser would have to know the login token before it was emailed. The
 * REST API accepts a private key via `accessToken`, so all sends happen here,
 * in the Worker, where the key stays secret.
 *
 * WHY ONE TEMPLATE: EmailJS free allows 2 templates. Rather than burn them on
 * two of the four email types, we use a single generic template and pass the
 * subject, heading, body and button in as variables.
 */

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';

// ---------------------------------------------------------------------------
// SPIKE, 6 Aug 2026. Direct-SMTP alternative to EmailJS: sends straight to
// the existing mail.visionbrokers.co.za mailbox over Cloudflare's TCP
// sockets, via the `worker-mailer` package, instead of going through
// EmailJS's REST API and its 200/month quota. See
// EMAIL-PROVIDER-COMPARISON-2026-08-06.md for why.
//
// Deliberately NOT wired into sendEmail() yet, and nothing above this call
// site changes. This exists only so a one-off admin test route (see
// /api/debug/test-smtp in index.js) can send a single real email and prove
// the approach works before anything live depends on it.
//
// New secrets this needs, set the same way as the EmailJS ones:
//   npx wrangler secret put SMTP_USERNAME   (vibetracker@visionbrokers.co.za)
//   npx wrangler secret put SMTP_PASSWORD   (that mailbox's real password)
// Host/port default to the same values EmailJS's SMTP service already uses
// (mail.visionbrokers.co.za, port 465, SSL), overridable via env if ever
// needed.
// ---------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {object} msg   same shape as sendEmail()'s msg, see below
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendEmailDirectSmtp(env, msg) {
  if (!env.SMTP_USERNAME || !env.SMTP_PASSWORD) {
    return { ok: false, error: 'SMTP_USERNAME / SMTP_PASSWORD not set. Run: npx wrangler secret put SMTP_USERNAME (and SMTP_PASSWORD)' };
  }

  const bodyText =
    `${msg.heading || msg.subject}\n\n${msg.body}\n` +
    (msg.ctaUrl ? `\n${msg.ctaLabel || 'Open'}: ${msg.ctaUrl}\n` : '');

  try {
    // Lazy import: keeps this dependency out of the way of the live email
    // path entirely unless this function is actually called.
    const { WorkerMailer } = await import('worker-mailer');

    const mailer = await WorkerMailer.connect({
      host: env.SMTP_HOST || 'mail.visionbrokers.co.za',
      port: Number(env.SMTP_PORT || 465),
      secure: true,
      credentials: {
        username: env.SMTP_USERNAME,
        password: env.SMTP_PASSWORD,
      },
      authType: 'plain',
    });

    await mailer.send({
      from: { name: 'VIBE Tracker', email: env.SMTP_USERNAME },
      to: msg.toEmail,
      subject: msg.subject,
      text: bodyText,
      html: buildHtmlEmail(msg),
    });

    return { ok: true };
  } catch (err) {
    // Same philosophy as sendEmail(): never throw, a failed test send is
    // just a failed test send.
    console.error('Direct SMTP send failed', err);
    return { ok: false, error: String(err) };
  }
}

/**
 * HTML shell for direct-SMTP sends, styled to match the app's own dark
 * theme (same colours as public/index.html's --ink/--surface/--signal
 * variables) instead of arriving as a bare link. Table-based, all styles
 * inline, no external fonts or flexbox: Outlook desktop's rendering engine
 * ignores most of that, so this sticks to what it actually respects.
 */
function buildHtmlEmail(msg) {
  const heading = escapeHtml(msg.heading || msg.subject);
  const bodyHtml = escapeHtml(msg.body).replace(/\n/g, '<br>');
  const cta = msg.ctaUrl ? `
<tr><td style="padding:0 32px 32px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#3fd9c2;border-radius:6px;">
      <a href="${msg.ctaUrl}" style="display:inline-block;padding:12px 22px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#0e1015;text-decoration:none;border-radius:6px;">${escapeHtml(msg.ctaLabel || 'Open')}</a>
    </td>
  </tr></table>
</td></tr>` : '';

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#0e1015;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e1015;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#1b1f27;border:1px solid #2b3240;border-radius:10px;">
<tr><td style="padding:28px 32px 8px;">
  <div style="font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:20px;color:#eceff3;letter-spacing:0.3px;">VIBE <span style="color:#3fd9c2;">Tracker</span></div>
</td></tr>
<tr><td style="padding:8px 32px 4px;">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:700;color:#eceff3;">${heading}</div>
</td></tr>
<tr><td style="padding:8px 32px 24px;">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#c3c8d1;">${bodyHtml}</div>
</td></tr>
${cta}
<tr><td style="padding:0 32px 24px;border-top:1px solid #2b3240;">
  <div style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#5c6577;">Sent by the VIBE Tracker, direct from mail.visionbrokers.co.za.</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** True if toEmail is on the SMTP_PILOT_EMAILS allowlist (case-insensitive). */
function isPilotRecipient(env, toEmail) {
  if (!env.SMTP_PILOT_EMAILS || !toEmail) return false;
  return env.SMTP_PILOT_EMAILS
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(toEmail.toLowerCase());
}

/**
 * @param {object} env      Worker env bindings
 * @param {object} msg
 * @param {string} msg.toEmail
 * @param {string} msg.toName
 * @param {string} msg.subject
 * @param {string} msg.heading
 * @param {string} msg.body      plain text, newlines preserved by the template
 * @param {string} [msg.ctaUrl]
 * @param {string} [msg.ctaLabel]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendEmail(env, msg) {
  // Pilot rollout (6 Aug 2026): SMTP_PILOT_EMAILS is a comma-separated allowlist
  // of recipients who get direct SMTP instead of EmailJS, everyone else is
  // unaffected. Plan agreed with Sam: her alone first, then add Deoni after a
  // week if it holds up, then a full swap. "Full swap" should retire this
  // check entirely and make sendEmailDirectSmtp() the only path, not just grow
  // this list to all six people.
  if (isPilotRecipient(env, msg.toEmail)) {
    return sendEmailDirectSmtp(env, msg);
  }

  const payload = {
    service_id:  env.EMAILJS_SERVICE_ID,
    template_id: env.EMAILJS_TEMPLATE_ID,
    user_id:     env.EMAILJS_PUBLIC_KEY,
    accessToken: env.EMAILJS_PRIVATE_KEY,
    template_params: {
      to_email:  msg.toEmail,
      to_name:   msg.toName || '',
      subject:   msg.subject,
      heading:   msg.heading || msg.subject,
      body:      msg.body,
      cta_url:   msg.ctaUrl || '',
      cta_label: msg.ctaLabel || '',
    },
  };

  try {
    const res = await fetch(EMAILJS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      // Never throw. A failed notification must not break the action that
      // triggered it: adding someone to a project should still succeed even
      // if the email bounces.
      console.error('EmailJS send failed', res.status, text);
      return { ok: false, error: `${res.status} ${text}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('EmailJS threw', err);
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Message builders. Kept here so all copy lives in one place.
// ---------------------------------------------------------------------------

export function magicLinkEmail(user, url) {
  return {
    toEmail: user.email,
    toName: user.name,
    subject: 'Your VIBE tracker login link',
    heading: `Hi ${user.name}`,
    body:
      'Click the button below to sign in to the VIBE operations tracker.\n\n' +
      'This link works once and expires in 15 minutes. If you did not request ' +
      'it, you can ignore this email and nothing will happen.',
    ctaUrl: url,
    ctaLabel: 'Sign in to VIBE',
  };
}

export function addedToProjectEmail(user, project, addedBy, url) {
  return {
    toEmail: user.email,
    toName: user.name,
    subject: `You have been added to ${project.name}`,
    heading: `You are now an owner of ${project.name}`,
    body:
      `${addedBy.name} added you as an owner of "${project.name}" on the VIBE tracker.\n\n` +
      `Current status: ${statusLabel(project.status)}\n` +
      (project.target_text ? `${project.target_text}\n` : '') +
      '\nOpen the tracker to see what is outstanding.',
    ctaUrl: url,
    ctaLabel: 'View the project',
  };
}

export function addedToTaskEmail(user, task, project, addedBy, url) {
  return {
    toEmail: user.email,
    toName: user.name,
    subject: `New task assigned: ${task.name}`,
    heading: 'A task was assigned to you',
    body:
      `${addedBy.name} assigned you a task on the VIBE tracker.\n\n` +
      `Project: ${project.name}\n` +
      `Task: ${task.name}\n` +
      (task.due_date ? `Due: ${task.due_date}\n` : '') +
      (task.note ? `Note: ${task.note}\n` : ''),
    ctaUrl: url,
    ctaLabel: 'Open the task',
  };
}

export function nudgeEmail(user, task, project, askedBy, url) {
  return {
    toEmail: user.email,
    toName: user.name,
    subject: `Update needed: ${task.name}`,
    heading: `${askedBy.name} is asking for an update`,
    body:
      `Project: ${project.name}\n` +
      `Task: ${task.name}\n` +
      `Current status: ${taskStatusLabel(task.status)}\n` +
      (task.due_date ? `Due: ${task.due_date}\n` : '') +
      '\nOpen the tracker and update the status or leave a note. It takes a few seconds.',
    ctaUrl: url,
    ctaLabel: 'Post an update',
  };
}

/**
 * Automatic due-date reminder. Sent by the "VIBE Tracker" system user, not a
 * person, so the copy is deliberately different from nudgeEmail() (no
 * "X is asking for an update") even though it goes through the same
 * sendEmail() and the same nudges-table dedup/rate-limit as a manual Nudge.
 */
export function dueDateReminderEmail(user, task, project, url, isOverdue) {
  return {
    toEmail: user.email,
    toName: user.name,
    subject: `${isOverdue ? 'Overdue' : 'Due soon'}: ${task.name}`,
    heading: `VIBE Tracker: this task is ${isOverdue ? 'overdue' : 'due soon'}`,
    body:
      `Project: ${project.name}\n` +
      `Task: ${task.name}\n` +
      `Current status: ${taskStatusLabel(task.status)}\n` +
      `Due: ${task.due_date}\n` +
      '\nThis is an automatic reminder, not a person nudging you. Open the tracker ' +
      'and update the status or leave a note once you have.',
    ctaUrl: url,
    ctaLabel: 'Open the task',
  };
}

/**
 * Sent to a task's other owners when someone adds or edits a note on it.
 * Not the person who made the change (that exclusion happens at the call
 * site, see notifyOtherOwnersOfNoteActivity in index.js). No rate limit,
 * unlike Nudge/due-date reminders: this is informational, not a chase.
 */
export function noteActivityEmail(user, task, project, actor, url, { action, noteText }) {
  const preview = noteText.length > 160 ? `${noteText.slice(0, 157)}…` : noteText;
  return {
    toEmail: user.email,
    toName: user.name,
    subject: `Note ${action}: ${task.name}`,
    heading: `${actor.name} ${action} a note on a task you own`,
    body:
      `Project: ${project.name}\n` +
      `Task: ${task.name}\n\n` +
      `"${preview}"\n\n` +
      'Open the tracker to see the full task.',
    ctaUrl: url,
    ctaLabel: 'Open the task',
  };
}

export function joinRequestEmail(admin, requester, url) {
  return {
    toEmail: admin.email,
    toName: admin.name,
    subject: `Access request: ${requester.email}`,
    heading: 'Someone requested access to the VIBE tracker',
    body:
      `${requester.name || requester.email} asked to join the VIBE tracker.\n\n` +
      `Email: ${requester.email}\n\n` +
      'They cannot sign in until an admin approves them. If you do not recognise ' +
      'this address, reject it.',
    ctaUrl: url,
    ctaLabel: 'Review the request',
  };
}

export function approvedEmail(user, approvedBy, url) {
  return {
    toEmail: user.email,
    toName: user.name,
    subject: 'You have access to the VIBE tracker',
    heading: 'Access approved',
    body:
      `${approvedBy.name} approved your access to the VIBE operations tracker.\n\n` +
      'Use the button below to sign in. This link works once and expires in 15 minutes. ' +
      'After that, request a fresh link from the sign-in page any time.',
    ctaUrl: url,
    ctaLabel: 'Sign in to VIBE',
  };
}

// ---------------------------------------------------------------------------

function statusLabel(s) {
  return { 'on-track': 'On track', 'at-risk': 'At risk', blocked: 'Blocked', paused: 'Paused' }[s] || s;
}

function taskStatusLabel(s) {
  return {
    'not-started': 'Not started',
    'in-progress': 'In progress',
    blocked: 'Blocked',
    paused: 'Paused',
    done: 'Done',
  }[s] || s;
}
