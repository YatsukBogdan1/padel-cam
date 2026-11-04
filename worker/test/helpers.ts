// Test fixtures. Everything goes through the Worker's real HTTP and WebSocket
// surface where it can, so a test fails when a player or a camera would notice --
// not merely when a column is wrong.

import { env, SELF } from 'cloudflare:test';
import { SESSION_COOKIE } from '../src/auth';
import type { CameraCommand, Match, Recording } from '../src/types';

export const BASE = 'http://padel.test';

/**
 * A real phone's user agent. Page views and downloads are only counted for
 * browsers -- link-preview bots and scripts are not players -- so any test that
 * asserts on a count must look like one.
 */
export const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** SELF.fetch from a phone's browser. */
export function phone(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('user-agent', PHONE_UA);
  return SELF.fetch(`${BASE}${path}`, { redirect: 'manual', ...init, headers });
}
export const DEVICE_TOKEN = 'test-device-token';

/**
 * A camera agent, minus the camera. Connects over the real `/agent` WebSocket,
 * so commands travel through the real Durable Object, and acknowledges them the
 * way the real agent does. `ackOk = false` makes it refuse, like an agent that
 * is already recording.
 */
export class FakeCamera {
  readonly commands: CameraCommand[] = [];
  ackOk = true;
  private ws!: WebSocket;

  constructor(readonly courtId: string) {}

  async connect(): Promise<this> {
    const res = await SELF.fetch(
      `${BASE}/agent?courtId=${encodeURIComponent(this.courtId)}&token=${DEVICE_TOKEN}`,
      { headers: { Upgrade: 'websocket' } },
    );
    if (res.status !== 101 || !res.webSocket) {
      throw new Error(`agent connect failed: HTTP ${res.status}`);
    }
    this.ws = res.webSocket;
    this.ws.accept();
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as CameraCommand;
      if (msg.type === 'heartbeat-ack' || msg.type === 'resume-plan') return;
      this.commands.push(msg);
      if ('commandId' in msg) {
        this.ws.send(
          JSON.stringify({
            type: 'ack',
            commandId: msg.commandId,
            ok: this.ackOk,
            ...(this.ackOk ? {} : { error: 'camera is already recording' }),
          }),
        );
      }
    });
    // hello stamps last_seen, which is what makes the court read online.
    this.ws.send(JSON.stringify({ type: 'hello', version: 'test' }));
    await waitUntil(async () => {
      const row = await env.DB.prepare(`SELECT last_seen FROM courts WHERE id = ?`)
        .bind(this.courtId)
        .first<{ last_seen: number | null }>();
      return row?.last_seen != null && Date.now() - row.last_seen < 5_000;
    });
    return this;
  }

  /** Commands of one type received so far. */
  received<T extends CameraCommand['type']>(type: T): Extract<CameraCommand, { type: T }>[] {
    return this.commands.filter((c) => c.type === type) as Extract<CameraCommand, { type: T }>[];
  }

  close(): void {
    try {
      this.ws.close(1000, 'test done');
    } catch {
      // already closed
    }
  }
}

/** A venue with one court that has a camera online and a printed QR sticker. */
export async function seedCourt(opts: {
  courtId?: string;
  venueId?: string;
  qrToken?: string;
  timezone?: string;
  slotMinutes?: number;
  connect?: boolean;
} = {}): Promise<{ courtId: string; venueId: string; qrToken: string; camera: FakeCamera | null }> {
  // Unique per call: a court's Durable Object (its socket, its alarm) outlives a
  // test, so reusing an id would hand the next test the last one's state.
  const courtId = opts.courtId ?? `court-${crypto.randomUUID().slice(0, 8)}`;
  const venueId = opts.venueId ?? 'club-a';
  const qrToken = opts.qrToken ?? `qr-${courtId}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO venues (id, name, created_at, timezone, slot_minutes) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(venueId, 'Test Club', Date.now(), opts.timezone ?? 'Europe/Lisbon', opts.slotMinutes ?? 30)
    .run();
  const camera = opts.connect === false ? null : await new FakeCamera(courtId).connect();
  // The camera's connect upserts the court row; offline seeding inserts it.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO courts (id, name, online, created_at) VALUES (?, NULL, 0, ?)`,
  )
    .bind(courtId, Date.now())
    .run();
  await env.DB.prepare(`UPDATE courts SET venue_id = ?, qr_token = ?, name = ? WHERE id = ?`)
    .bind(venueId, qrToken, 'Court A', courtId)
    .run();
  return { courtId, venueId, qrToken, camera };
}

/**
 * D1 is shared by every test in a file, so each test starts from empty tables --
 * otherwise one test's live recording makes the next test's court look busy.
 */
export async function resetDb(): Promise<void> {
  const tables = [
    'funnel_events', 'feedback', 'recording_events', 'share_links', 'matches', 'recordings', 'sessions', 'admins',
    'courts', 'venues', 'alerts', 'incidents', 'expenses',
  ];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

/** A signed-in admin, as a cookie header. Superadmin optional. */
export async function adminCookie(venueId: string, superadmin = false): Promise<string> {
  const adminId = crypto.randomUUID();
  const token = crypto.randomUUID();
  await env.DB.prepare(`INSERT OR IGNORE INTO venues (id, name, created_at) VALUES (?, ?, ?)`)
    .bind(venueId, venueId, Date.now())
    .run();
  await env.DB.prepare(
    `INSERT INTO admins (id, venue_id, email, password_hash, created_at, is_superadmin)
     VALUES (?, ?, ?, 'unused', ?, ?)`,
  )
    .bind(adminId, venueId, `${adminId}@test`, Date.now(), superadmin ? 1 : 0)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (token, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(token, adminId, Date.now() + 3_600_000, Date.now())
    .run();
  return `${SESSION_COOKIE}=${token}`;
}

/** What a phone gets back from pressing Start on the court page. */
export interface Started {
  res: Response;
  /** The match link's secret, when the start succeeded. */
  token: string | null;
  /** `name=value` of the cookie the phone now holds. */
  cookie: string | null;
  setCookie: string | null;
}

export async function startFromCourt(
  qrToken: string,
  opts: { until?: number; consent?: boolean; visit?: string; lang?: string; acceptLanguage?: string } = {},
): Promise<Started> {
  const body = new URLSearchParams();
  body.set('until', String(opts.until ?? Date.now() + 60 * 60_000));
  if (opts.consent !== false) body.set('consent', 'yes');
  if (opts.visit) body.set('visit', opts.visit);
  const headers: Record<string, string> = { 'user-agent': PHONE_UA };
  if (opts.acceptLanguage) headers['accept-language'] = opts.acceptLanguage;
  // The form's action carries ?lang= when the player chose a language.
  const res = await SELF.fetch(`${BASE}/c/${qrToken}/start${opts.lang ? `?lang=${opts.lang}` : ''}`, {
    method: 'POST',
    body,
    redirect: 'manual',
    headers,
  });
  const location = res.headers.get('location');
  const setCookie = res.headers.get('set-cookie');
  return {
    res,
    token: location?.startsWith('/m/') ? location.slice(3).split('?')[0]! : null,
    cookie: setCookie ? setCookie.split(';')[0]! : null,
    setCookie,
  };
}

export function getMatchByToken(token: string): Promise<Match | null> {
  return env.DB.prepare(`SELECT * FROM matches WHERE token = ?`).bind(token).first<Match>();
}

export async function segmentsOf(sessionId: string): Promise<Recording[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM recordings WHERE session_id = ? ORDER BY segment`,
  )
    .bind(sessionId)
    .all<Recording>();
  return results ?? [];
}

/** Deliver footage the way the agent does: PUT the part, then POST /complete. */
export async function deliverFootage(recordingId: string, bytes: Uint8Array): Promise<Response> {
  const put = await SELF.fetch(`${BASE}/api/recordings/${recordingId}/part/1`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-length': String(bytes.length) },
    body: bytes,
  });
  if (!put.ok) throw new Error(`part upload failed: ${put.status} ${await put.text()}`);
  const part = (await put.json()) as { partNumber: number; etag: string };
  return SELF.fetch(`${BASE}/api/recordings/${recordingId}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [part] }),
  });
}

export async function eventCounts(): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT kind, COUNT(*) AS n FROM recording_events GROUP BY kind`,
  ).all<{ kind: string; n: number }>();
  return Object.fromEntries((results ?? []).map((r) => [r.kind, r.n]));
}

/**
 * Events are written with ctx.waitUntil, after the response. Poll rather than
 * sleep a guessed amount.
 */
export async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}

export function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 251;
  return out;
}
