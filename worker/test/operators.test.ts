// The operator side of the new flow: staff starting matches from the dashboard,
// and the super-admin routes that print stickers and set the booking grid.

import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE, adminCookie, seedCourt, startFromCourt, type FakeCamera } from './helpers';

let camera: FakeCamera | null = null;
afterEach(() => {
  camera?.close();
  camera = null;
});

async function setup() {
  const seeded = await seedCourt();
  camera = seeded.camera;
  return seeded;
}

function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('staff start', () => {
  it('without an end time, runs until stopped -- capped at 3 hours', async () => {
    const { courtId, venueId } = await setup();
    const cookie = await adminCookie(venueId);
    const before = Date.now();

    const res = await post('/api/recordings/start', cookie, { courtId });
    expect(res.status).toBe(201);
    const rec = (await res.json()) as { id: string; session_id: string };

    const match = await env.DB.prepare(`SELECT * FROM matches WHERE session_id = ?`)
      .bind(rec.session_id)
      .first<{ started_by: string; ends_at: number }>();
    expect(match?.started_by).toBe('staff');
    expect(match!.ends_at - before).toBeGreaterThanOrEqual(3 * 3_600_000 - 1_000);
    expect(match!.ends_at - before).toBeLessThanOrEqual(3 * 3_600_000 + 5_000);
    expect(camera!.received('start')).toHaveLength(1);
  });

  it('with an end time from the grid, auto-stops there', async () => {
    const { courtId, venueId } = await setup();
    const cookie = await adminCookie(venueId);
    const courts = (await (await SELF.fetch(`${BASE}/api/courts`, { headers: { cookie } })).json()) as {
      endOptions: { at: number; label: string }[];
    };
    expect(courts.endOptions.length).toBeGreaterThan(0);
    const until = courts.endOptions[0]!.at;

    const res = await post('/api/recordings/start', cookie, { courtId, bookedUntil: until });
    expect(res.status).toBe(201);
    const rec = (await res.json()) as { session_id: string };
    const match = await env.DB.prepare(`SELECT ends_at FROM matches WHERE session_id = ?`)
      .bind(rec.session_id)
      .first<{ ends_at: number }>();
    expect(match?.ends_at).toBe(until);
  });

  it('cannot start another venue’s court', async () => {
    const { courtId } = await setup();
    const cookie = await adminCookie('other-club');
    expect((await post('/api/recordings/start', cookie, { courtId })).status).toBe(404);
    expect(camera!.received('start')).toHaveLength(0);
  });

  it('and a player cannot start over a staff match', async () => {
    const { courtId, venueId, qrToken } = await setup();
    await post('/api/recordings/start', await adminCookie(venueId), { courtId });
    expect((await startFromCourt(qrToken)).res.status).toBe(409);
  });
});

describe('QR card', () => {
  it('issues a sticker token on first print, and the sticker then works', async () => {
    const { courtId, venueId } = await setup();
    await env.DB.prepare(`UPDATE courts SET qr_token = NULL WHERE id = ?`).bind(courtId).run();
    const cookie = await adminCookie(venueId, true);

    const res = await SELF.fetch(`${BASE}/api/super/courts/${courtId}/qr`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<svg');
    expect(html).toContain('Record your match');
    expect(html).toContain('no sound'); // the notice players read before filming

    const token = html.match(/\/c\/([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    const court = await env.DB.prepare(`SELECT qr_token FROM courts WHERE id = ?`)
      .bind(courtId)
      .first<{ qr_token: string }>();
    expect(court?.qr_token).toBe(token);
    expect((await SELF.fetch(`${BASE}/c/${token}`)).status).toBe(200);

    // Printing again keeps the same token -- a reprint must not kill the first sticker.
    const again = await (await SELF.fetch(`${BASE}/api/super/courts/${courtId}/qr`, { headers: { cookie } })).text();
    expect(again).toContain(`/c/${token}`);
  });

  it('does not exist for a venue admin', async () => {
    const { courtId, venueId } = await setup();
    const res = await SELF.fetch(`${BASE}/api/super/courts/${courtId}/qr`, {
      headers: { cookie: await adminCookie(venueId) },
    });
    expect(res.status).toBe(404);
  });

  it('refuses a court with no venue', async () => {
    const { courtId, venueId } = await setup();
    await env.DB.prepare(`UPDATE courts SET venue_id = NULL WHERE id = ?`).bind(courtId).run();
    const res = await SELF.fetch(`${BASE}/api/super/courts/${courtId}/qr`, {
      headers: { cookie: await adminCookie(venueId, true) },
    });
    expect(res.status).toBe(409);
  });

  it('rotating kills the old sticker immediately', async () => {
    const { courtId, venueId, qrToken } = await setup();
    const res = await post(`/api/super/courts/${courtId}/qr/rotate`, await adminCookie(venueId, true), {});
    expect(res.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/c/${qrToken}`)).status).toBe(404);
  });
});

describe('venue booking grid', () => {
  it('validates the timezone and the slot length', async () => {
    const { venueId } = await setup();
    const cookie = await adminCookie(venueId, true);
    const path = `/api/super/venues/${venueId}`;
    expect((await post(path, cookie, { timezone: 'Mars/Olympus', slotMinutes: 30 })).status).toBe(400);
    expect((await post(path, cookie, { timezone: 'Europe/Madrid', slotMinutes: 25 })).status).toBe(400);
    expect((await post('/api/super/venues/nope', cookie, { timezone: 'Europe/Madrid', slotMinutes: 30 })).status).toBe(404);

    expect((await post(path, cookie, { timezone: 'Europe/Madrid', slotMinutes: 60 })).status).toBe(200);
    const venue = await env.DB.prepare(`SELECT timezone, slot_minutes FROM venues WHERE id = ?`)
      .bind(venueId)
      .first<{ timezone: string; slot_minutes: number }>();
    expect(venue).toEqual({ timezone: 'Europe/Madrid', slot_minutes: 60 });
  });

  it('is super-admin only', async () => {
    const { venueId } = await setup();
    const res = await post(`/api/super/venues/${venueId}`, await adminCookie(venueId), {
      timezone: 'Europe/Madrid',
      slotMinutes: 30,
    });
    expect(res.status).toBe(404);
  });
});

describe('experiment readout', () => {
  it('counts player-started matches and shared links per court', async () => {
    const { qrToken, courtId, venueId } = await setup();
    const started = await startFromCourt(qrToken);
    await SELF.fetch(`${BASE}/m/${started.token}/shared`, { method: 'POST' });

    const res = await SELF.fetch(`${BASE}/api/super/overview`, {
      headers: { cookie: await adminCookie(venueId, true) },
    });
    const body = (await res.json()) as {
      engagement: { court_id: string; player_matches: number; shared_matches: number }[];
    };
    const row = body.engagement.find((e) => e.court_id === courtId);
    expect(row).toMatchObject({ player_matches: 1, shared_matches: 1 });
  });
});
