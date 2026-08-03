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
