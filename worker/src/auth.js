/**
 * Magic link authentication.
 *
 * Threat model, stated plainly: this app holds internal project statuses, not
 * client PII, money movement or POPIA-regulated personal data. Magic links move
 * the security question from "how good is everyone's password" to "how well
 * protected is everyone's mailbox". Since every user's mailbox is already the
 * master key to every password reset they own, that is a net win at this scale.
 *
 * If this app ever holds client records, revisit and add passkeys or Google SSO.
 *
 * The four things that actually matter, all implemented below:
 *   1. Tokens are cryptographically random (32 bytes), never Math.random.
 *   2. Only the SHA-256 hash is stored, so a DB leak yields no working links.
 *   3. Tokens expire in 15 minutes.
 *   4. Tokens are single use, invalidated the moment they are redeemed.
 */

const MAGIC_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30;
const COOKIE_NAME = 'vibe_session';

// ---------------------------------------------------------------------------
// Token primitives
// ---------------------------------------------------------------------------

/** 32 random bytes, hex encoded. 256 bits of entropy, not guessable. */
export function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);
}

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Magic links
// ---------------------------------------------------------------------------

/** Creates a single-use magic token for a user and returns the full sign-in URL. */
export async function createMagicLink(env, userId) {
  const token = generateToken();
  const tokenHash = await hashToken(token);

  // Any older unused token for this user stops working the moment a new one is
  // issued. Prevents a stack of live links piling up in someone's inbox.
  await env.DB.prepare(
    `UPDATE magic_tokens SET used_at = ?1 WHERE user_id = ?2 AND used_at IS NULL`
  ).bind(nowIso(), userId).run();

  await env.DB.prepare(
    `INSERT INTO magic_tokens (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)`
  ).bind(tokenHash, userId, isoIn(MAGIC_TTL_MINUTES * 60 * 1000)).run();

  return `${env.APP_URL}/api/auth/verify?token=${token}`;
}

/**
 * Redeems a magic token. Returns the user, or null if the token is unknown,
 * expired, already used, or belongs to a user who is no longer active.
 */
export async function redeemMagicLink(env, token) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = await hashToken(token);

  const row = await env.DB.prepare(
    `SELECT t.token_hash, t.user_id, t.expires_at, t.used_at,
            u.name, u.email, u.role, u.status
       FROM magic_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?1`
  ).bind(tokenHash).first();

  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at < nowIso()) return null;
  if (row.status !== 'active') return null;

  // Burn it. Single use is what makes a forwarded or leaked link harmless
  // after the first click.
  await env.DB.prepare(
    `UPDATE magic_tokens SET used_at = ?1 WHERE token_hash = ?2`
  ).bind(nowIso(), tokenHash).run();

  return { id: row.user_id, name: row.name, email: row.email, role: row.role, status: row.status };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(env, userId) {
  const token = generateToken();
  const tokenHash = await hashToken(token);
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)`
  ).bind(tokenHash, userId, isoIn(SESSION_TTL_DAYS * 86400 * 1000)).run();
  return token;
}

export function sessionCookie(token) {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',            // JavaScript cannot read it, so XSS cannot steal the session
    'Secure',              // HTTPS only
    'SameSite=Lax',        // survives the click-through from the email, blocks CSRF
    `Max-Age=${SESSION_TTL_DAYS * 86400}`,
  ].join('; ');
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** Returns the signed-in user, or null. Call this on every protected route. */
export async function getSessionUser(env, request) {
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.name, u.email, u.role, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1`
  ).bind(await hashToken(token)).first();

  if (!row) return null;
  if (row.expires_at < nowIso()) return null;
  // Revoking access is immediate: flip status to rejected and existing sessions
  // stop working on the next request, no need to hunt down cookies.
  if (row.status !== 'active') return null;

  return { id: row.user_id, name: row.name, email: row.email, role: row.role };
}

export async function destroySession(env, request) {
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return;
  await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`)
    .bind(await hashToken(token)).run();
}

/** Housekeeping. Cheap, so it runs opportunistically on sign-in. */
export async function purgeExpired(env) {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions     WHERE expires_at < ?1`).bind(now),
    env.DB.prepare(`DELETE FROM magic_tokens WHERE expires_at < ?1`).bind(now),
  ]);
}
