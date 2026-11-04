/**
 * Admin authentication: password hashing, server-side sessions, cookies.
 *
 * Sessions are rows in D1 rather than stateless signed cookies, so logging out
 * genuinely invalidates the session instead of leaving a valid token alive until
 * it expires.
 */
import type { Admin, Env, Session } from './types';

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — a venue shift, not a month
export const SESSION_COOKIE = 'padel_session';

// ---- encoding helpers ---------------------------------------------------------

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** URL-safe random token — used for session cookies and share links. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- passwords ----------------------------------------------------------------

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Produce `pbkdf2$<iterations>$<salt-b64>$<hash-b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

/** Constant-time comparison, so a wrong password can't be found byte by byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const salt = fromB64(parts[2]!);
  const expected = fromB64(parts[3]!);
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

// ---- cookies ------------------------------------------------------------------

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || null;
  }
  return null;
}

/**
 * HttpOnly so page scripts can't read the token; SameSite=Lax so ordinary
 * navigation and the share page still work. `Secure` is conditional: it is
 * always set in production, but omitted over plain http so `wrangler dev` on
 * localhost behaves the same as the deployed Worker.
 */
export function sessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}

/** True when the request arrived over HTTPS, i.e. anywhere but local dev. */
export function isSecureRequest(req: Request): boolean {
  return new URL(req.url).protocol === 'https:';
}

// ---- sessions -----------------------------------------------------------------

export async function createSession(env: Env, adminId: string): Promise<Session> {
  const now = Date.now();
  const session: Session = {
    token: randomToken(32),
    admin_id: adminId,
    expires_at: now + SESSION_TTL_MS,
    created_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO sessions (token, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(session.token, session.admin_id, session.expires_at, session.created_at)
    .run();
  return session;
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
}

/** Resolve the signed-in admin, or null. Expired sessions are deleted on sight. */
export async function currentAdmin(req: Request, env: Env): Promise<Admin | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT a.*, s.expires_at AS session_expires
       FROM sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token = ?`,
  )
    .bind(token)
    .first<Admin & { session_expires: number }>();

  if (!row) return null;
  if (row.session_expires < Date.now()) {
    await deleteSession(env, token);
    return null;
  }
  const { session_expires: _drop, ...admin } = row;
  return admin as Admin;
}

export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
