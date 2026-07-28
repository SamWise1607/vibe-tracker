/**
 * Test harness: runs the real Hono app against a real SQLite database using a
 * shim that mimics Cloudflare's D1 API, and a fake email transport that records
 * every message instead of sending it.
 *
 * Run with:  node --experimental-sqlite test/run.mjs
 *
 * This is not a substitute for `wrangler dev`, but it catches the things that
 * actually break: wrong SQL, wrong route, wrong auth check, wrong payload shape.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// --- D1 shim ---------------------------------------------------------------

class D1Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new D1Statement(this.db, this.sql, args); }

  #norm(a) {
    // node:sqlite rejects undefined and booleans; D1 accepts them loosely.
    return a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }
  #prep() {
    // D1 accepts both ?1-style and bare ? placeholders. node:sqlite is fussier
    // about mixing, but each query here uses one style consistently.
    return this.db.prepare(this.sql);
  }

  async first() { return this.#prep().get(...this.#norm(this.args)) ?? null; }
  async all()   { return { results: this.#prep().all(...this.#norm(this.args)), success: true }; }
  async run()   {
    const r = this.#prep().run(...this.#norm(this.args));
    return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
  }
}

class D1Database {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

// --- Environment -----------------------------------------------------------

export function makeEnv({ schema, seed }) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(schema, 'utf8'));
  if (seed) db.exec(readFileSync(seed, 'utf8'));

  return {
    DB: new D1Database(db),
    APP_URL: 'https://vibe-tracker.test.workers.dev',
    EMAILJS_SERVICE_ID: 'svc_test',
    EMAILJS_TEMPLATE_ID: 'tpl_test',
    EMAILJS_PUBLIC_KEY: 'pub_test',
    EMAILJS_PRIVATE_KEY: 'priv_test',
    _rawDb: db,
  };
}

// --- Fake EmailJS ----------------------------------------------------------

export const outbox = [];

export function installFakeEmail({ failNext = false } = {}) {
  outbox.length = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.emailjs.com')) {
      const payload = JSON.parse(init.body);
      if (failNext) return new Response('quota exceeded', { status: 429 });
      outbox.push(payload.template_params);
      return new Response('OK', { status: 200 });
    }
    throw new Error(`Unexpected outbound fetch to ${url}`);
  };
}

// --- Request helpers -------------------------------------------------------

export function req(path, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return new Request(`https://vibe-tracker.test.workers.dev${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Pull the session cookie value out of a Set-Cookie header. */
export function cookieFrom(res) {
  const raw = res.headers.get('Set-Cookie') || '';
  const m = raw.match(/vibe_session=([^;]*)/);
  return m ? `vibe_session=${m[1]}` : null;
}

/** Extract the magic token from the most recent email's CTA url. */
export function tokenFromLastEmail() {
  const last = outbox[outbox.length - 1];
  if (!last) return null;
  const m = String(last.cta_url).match(/token=([a-f0-9]+)/);
  return m ? m[1] : null;
}

// --- Tiny assertion library ------------------------------------------------

export const results = { passed: 0, failed: 0, failures: [] };

export function check(name, condition, detail = '') {
  if (condition) { results.passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else {
    results.failed++;
    results.failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '\n          ' + detail : ''}`);
  }
}

export function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }
