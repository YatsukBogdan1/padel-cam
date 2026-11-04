// The player funnel: every step is recorded once per visit or match, from people
// only, and the readout on /super adds up. Plus the feedback rules -- asked once,
// only about a video the player has actually got.

import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE,
  adminCookie,
  bytes,
  deliverFootage,
  getMatchByToken,
  phone,
  seedCourt,
  segmentsOf,
  startFromCourt,
  waitUntil,
  type FakeCamera,
} from './helpers';

let camera: FakeCamera | null = null;
afterEach(() => {
  camera?.close();
  camera = null;
});

async function setup(opts: Parameters<typeof seedCourt>[0] = {}) {
  const seeded = await seedCourt(opts);
  camera = seeded.camera;
  return seeded;
}

async function steps(): Promise<{ step: string; detail: string | null; visit_id: string | null; session_id: string | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT step, detail, visit_id, session_id FROM funnel_events ORDER BY id`,
  ).all<{ step: string; detail: string | null; visit_id: string | null; session_id: string | null }>();
  return results ?? [];
}

/** waitUntil-written rows land after the response; wait for `n` of them. */
async function settle(n: number) {
  await waitUntil(async () => (await steps()).length >= n);
}

function beacon(token: string, body: unknown, ua = true) {
  const init = { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain' } };
  return ua ? phone(`/m/${token}/e`, init) : SELF.fetch(`${BASE}/m/${token}/e`, init);
}

function feedback(token: string, body: unknown) {
  return phone(`/m/${token}/feedback`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/** Scan, start, share by WhatsApp, stop, deliver: a ready match with a known visit. */
async function playedMatch(qrToken: string) {
  const scanPage = await (await phone(`/c/${qrToken}`)).text();
  const visit = scanPage.match(/name="visit" value="([^"]+)"/)![1]!;
  const started = await startFromCourt(qrToken, { visit });
  const token = started.token!;
  const match = (await getMatchByToken(token))!;
  await phone(`/m/${token}/shared?how=whatsapp`, { method: 'POST' });
  await phone(`/m/${token}?via=share`); // a friend opens the link while it records
  await phone(`/m/${token}/stop`, { method: 'POST' });
  const [rec] = await segmentsOf(match.session_id);
  expect((await deliverFootage(rec!.id, bytes(2048))).status).toBe(200);
  return { visit, token, match };
}

describe('the funnel, end to end', () => {
  it('records each step once and the /super readout adds up', async () => {
    const { qrToken, courtId, venueId } = await setup();
    const { visit, token, match } = await playedMatch(qrToken);

    await phone(`/m/${token}`); // the starter comes back once it is ready
    await beacon(token, { step: 'play' });
    await beacon(token, { step: 'watch_30s' });
    await (await phone(`/m/${token}/video/1?dl=1`)).arrayBuffer();
    expect((await feedback(token, { rating: 'down' })).status).toBe(204);
    expect((await feedback(token, { comment: 'Camera angle cuts off the back wall' })).status).toBe(204);
    await settle(11);

    const all = await steps();
    // Before Start, steps join on the visit; after, on the match.
    expect(all.filter((e) => e.step === 'scan')[0]).toMatchObject({ detail: 'ready', visit_id: visit });
    expect(all.find((e) => e.step === 'start_attempt')?.visit_id).toBe(visit);
    expect(all.find((e) => e.step === 'started')).toMatchObject({ visit_id: visit, session_id: match.session_id });

    const res = await SELF.fetch(`${BASE}/api/super/funnel?days=7`, {
      headers: { cookie: await adminCookie(venueId, true) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; courts: Record<string, unknown>[] };
    expect(body.days).toBe(7);
    expect(body.courts.find((c) => c.court_id === courtId)).toMatchObject({
      scans: 1,
      scans_ready: 1,
      start_attempts: 1,
      started: 1,
      shared: 1,
      shared_by: { whatsapp: 1 },
      opened_by_others: 1,
      stopped_manual: 1,
      stopped_auto: 0,
      returned_ready: 1,
      played: 1,
      watched_30s: 1,
      downloaded: 1,
      feedback_up: 0,
      feedback_down: 1,
      comments: [expect.objectContaining({ rating: -1, comment: 'Camera angle cuts off the back wall' })],
    });
  });

  it('counts matches, not events -- refreshes and repeat plays add nothing', async () => {
    const { qrToken, courtId, venueId } = await setup();
    const { token } = await playedMatch(qrToken);
    for (let i = 0; i < 3; i++) {
      await phone(`/m/${token}`);
      await beacon(token, { step: 'play' });
    }
    await phone(`/m/${token}?r=1`); // the page's own auto-refresh is not a visit at all
    await settle(10);

    const res = await SELF.fetch(`${BASE}/api/super/funnel`, { headers: { cookie: await adminCookie(venueId, true) } });
    const row = ((await res.json()) as { courts: (Record<string, number> & { court_id: string })[] }).courts.find(
      (c) => c.court_id === courtId,
    )!;
    expect(row).toMatchObject({ returned_ready: 1, played: 1 });
    const refreshes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM funnel_events WHERE step = 'view_ready'`,
    ).first<{ n: number }>();
    expect(refreshes?.n).toBe(3);
  });

  it('leaves staff-started matches out of the player funnel', async () => {
    const { courtId, venueId } = await setup();
    const cookie = await adminCookie(venueId, true);
    await SELF.fetch(`${BASE}/api/recordings/start`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ courtId }),
    });
    const res = await SELF.fetch(`${BASE}/api/super/funnel`, { headers: { cookie } });
    const row = ((await res.json()) as { courts: (Record<string, number> & { court_id: string })[] }).courts.find(
      (c) => c.court_id === courtId,
    )!;
    expect(row.started).toBe(0);
  });
});

describe('scan outcomes', () => {
  it('records why a scan could not start: busy, offline, or the starter returning', async () => {
    const live = await setup();
    const started = await startFromCourt(live.qrToken);
    await phone(`/c/${live.qrToken}`); // someone else: busy
    await phone(`/c/${live.qrToken}`, { headers: { cookie: started.cookie! } }); // the starter: returning
    const dark = await seedCourt({ connect: false });
    await phone(`/c/${dark.qrToken}`); // offline
    await settle(5);

    const scans = (await steps()).filter((e) => e.step === 'scan').map((e) => e.detail).sort();
    expect(scans).toEqual(['busy', 'offline', 'returning']);
  });

  it('does not count the busy page refreshing itself', async () => {
    const { qrToken } = await setup();
    await startFromCourt(qrToken);
    const html = await (await phone(`/c/${qrToken}`)).text();
    expect(html).toContain(`url=/c/${qrToken}?r=1`);
    await phone(`/c/${qrToken}?r=1`);
    await phone(`/c/${qrToken}?r=1`);
    await settle(3);
    expect((await steps()).filter((e) => e.step === 'scan')).toHaveLength(1);
  });

  it('keeps ?via=share across the match page refresh', async () => {
    const { qrToken } = await setup();
    const { token } = await startFromCourt(qrToken);
    const html = await (await phone(`/m/${token}?via=share`)).text();
    expect(html).toContain(`url=/m/${token}?r=1&via=share`);
  });
});

describe('start failures', () => {
  async function failedReasons(): Promise<(string | null)[]> {
    await settle(1);
    return (await steps()).filter((e) => e.step === 'start_failed').map((e) => e.detail);
  }

  it('no consent tick', async () => {
    const { qrToken } = await setup();
    await startFromCourt(qrToken, { consent: false });
    await waitUntil(async () => (await failedReasons()).length === 1);
    expect(await failedReasons()).toEqual(['no_consent']);
  });

  it('an end time out of range', async () => {
    const { qrToken } = await setup();
    await startFromCourt(qrToken, { until: Date.now() + 60_000 });
    await waitUntil(async () => (await failedReasons()).length === 1);
    expect(await failedReasons()).toEqual(['invalid_time']);
  });

  it('the camera not answering', async () => {
    const { qrToken } = await setup();
    camera!.ackOk = false;
    await startFromCourt(qrToken);
    await waitUntil(async () => (await failedReasons()).length === 1);
    expect(await failedReasons()).toEqual(['camera']);
  });

  it('the court turning busy between scan and Start', async () => {
    const { qrToken } = await setup();
    await startFromCourt(qrToken);
    await startFromCourt(qrToken);
    await waitUntil(async () => (await failedReasons()).length === 1);
    expect(await failedReasons()).toEqual(['busy']);
  });

  it('the camera going offline between scan and Start', async () => {
    const { qrToken } = await setup({ connect: false });
    await startFromCourt(qrToken);
    await waitUntil(async () => (await failedReasons()).length === 1);
    expect(await failedReasons()).toEqual(['offline']);
  });

  it('a retry after an error is the same visit', async () => {
    const { qrToken } = await setup();
    const html = await (await phone(`/c/${qrToken}`)).text();
    const visit = html.match(/name="visit" value="([^"]+)"/)![1]!;
    const failed = await startFromCourt(qrToken, { consent: false, visit });
    // The error page hands the same visit back, so the retry joins up.
    expect(await failed.res.text()).toContain(`value="${visit}"`);
    await startFromCourt(qrToken, { visit });
    await settle(5);
    const visits = new Set((await steps()).filter((e) => e.step !== 'stopped').map((e) => e.visit_id));
    expect(visits).toEqual(new Set([visit]));
  });

  it('ignores a forged visit id', async () => {
    const { qrToken } = await setup();
    await startFromCourt(qrToken, { visit: "x'; DROP TABLE funnel_events; --" });
    await settle(2);
    const attempt = (await steps()).find((e) => e.step === 'start_attempt')!;
    expect(attempt.visit_id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });
});

describe('only people are counted', () => {
  const bots = [
    'WhatsApp/2.24.1 A',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'curl/8.4.0',
  ];

  it('link previews and scripts open the match link without counting', async () => {
    const { qrToken } = await setup();
    const { token } = await startFromCourt(qrToken);
    await settle(2);
    const before = (await steps()).length;
    for (const ua of bots) {
      await SELF.fetch(`${BASE}/m/${token}?via=share`, { headers: { 'user-agent': ua } });
      await SELF.fetch(`${BASE}/c/${qrToken}`, { headers: { 'user-agent': ua } });
    }
    await SELF.fetch(`${BASE}/m/${token}?via=share`); // no user agent at all
    await new Promise((r) => setTimeout(r, 100));
    expect((await steps()).length).toBe(before);
  });

  it('a script downloading the video is not a download', async () => {
    const { qrToken } = await setup();
    const { token } = await playedMatch(qrToken);
    const res = await SELF.fetch(`${BASE}/m/${token}/video/1?dl=1`, { headers: { 'user-agent': 'curl/8.4.0' } });
    expect(res.status).toBe(200); // still served -- just not counted
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 100));
    expect((await steps()).filter((e) => e.step === 'download')).toHaveLength(0);
  });
});

describe('browser events', () => {
  it('accepts only the allowlisted steps', async () => {
    const { qrToken } = await setup();
    const token = (await startFromCourt(qrToken)).token!;
    await settle(2);
    const before = (await steps()).length;
    for (const body of [
      { step: 'download' }, // a server-side step: never from the browser
      { step: 'started' },
      { step: 'share', detail: 'whatsapp' }, // share has its own endpoint
      { step: 'anything' },
      'not json',
    ]) {
      expect((await beacon(token, body)).status).toBe(204);
    }
    await beacon(token, { step: 'play', detail: 'ignored' });
    await beacon(token, { step: 'play' }, false); // no browser
    const after = (await steps()).slice(before);
    expect(after).toEqual([expect.objectContaining({ step: 'play', detail: null })]);
  });

  it('rejects events for a link that does not exist', async () => {
    await setup();
    expect((await beacon('AAAAAAAAAAAAAAAAAAAAAA', { step: 'play' })).status).toBe(404);
  });

  it('records how the link was shared, and only known ways', async () => {
    const { qrToken } = await setup();
    const token = (await startFromCourt(qrToken)).token!;
    for (const how of ['whatsapp', 'native', 'copy', 'carrier-pigeon']) {
      await phone(`/m/${token}/shared?how=${how}`, { method: 'POST' });
    }
    const shares = (await steps()).filter((e) => e.step === 'share').map((e) => e.detail);
    expect(shares).toEqual(['whatsapp', 'native', 'copy', null]);
  });

  it('records an auto-stop as auto and a staff stop as staff', async () => {
    const { qrToken, venueId } = await setup();
    const { token } = await startFromCourt(qrToken);
    const match = (await getMatchByToken(token!))!;
    const [rec] = await segmentsOf(match.session_id);
    await SELF.fetch(`${BASE}/api/recordings/stop`, {
      method: 'POST',
      headers: { cookie: await adminCookie(venueId), 'content-type': 'application/json' },
      body: JSON.stringify({ recordingId: rec!.id }),
    });
    expect((await steps()).find((e) => e.step === 'stopped')?.detail).toBe('staff');
  });
});

describe('feedback', () => {
  it('is not offered before the video exists', async () => {
    const { qrToken } = await setup();
    const { token } = await startFromCourt(qrToken);
    expect(await (await phone(`/m/${token}`)).text()).not.toContain('id="fb"');
    expect((await feedback(token!, { rating: 'up' })).status).toBe(409);
  });

  it('is rendered hidden, to be revealed by play or download', async () => {
    const { qrToken } = await setup();
    const { token } = await playedMatch(qrToken);
    const html = await (await phone(`/m/${token}`)).text();
    expect(html).toContain('<div id="fb" class="fb" hidden>');
    expect(html).toContain('Foi útil?');
  });

  it('is asked once per match, on any phone', async () => {
    const { qrToken } = await setup();
    const { token } = await playedMatch(qrToken);
    expect((await feedback(token, { rating: 'up' })).status).toBe(204);
    expect((await feedback(token, { rating: 'down' })).status).toBe(409);
    // A different phone opening the shared link is not asked again.
    expect(await (await phone(`/m/${token}?via=share`)).text()).not.toContain('id="fb"');
    const row = await env.DB.prepare(`SELECT rating FROM feedback`).first<{ rating: number }>();
    expect(row?.rating).toBe(1);
  });

  it('takes one optional comment, only after a rating, capped in length', async () => {
    const { qrToken } = await setup();
    const { token } = await playedMatch(qrToken);
    expect((await feedback(token, { comment: 'first!' })).status).toBe(409);
    await feedback(token, { rating: 'up' });
    expect((await feedback(token, { comment: 'x'.repeat(5000) })).status).toBe(204);
    expect((await feedback(token, { comment: 'second comment' })).status).toBe(409);
    const row = await env.DB.prepare(`SELECT comment FROM feedback`).first<{ comment: string }>();
    expect(row?.comment).toHaveLength(1000);
  });

  it('rejects anything that is not a rating or a comment', async () => {
    const { qrToken } = await setup();
    const { token } = await playedMatch(qrToken);
    expect((await feedback(token, { rating: 5 })).status).toBe(400);
    expect((await feedback(token, {})).status).toBe(400);
  });

  it('is not asked on a locked match', async () => {
    const { qrToken, courtId } = await setup();
    await env.DB.prepare(`UPDATE courts SET free_until = ? WHERE id = ?`).bind(Date.now() - 1, courtId).run();
    const { token } = await playedMatch(qrToken);
    expect(await (await phone(`/m/${token}`)).text()).not.toContain('id="fb"');
    expect((await feedback(token, { rating: 'up' })).status).toBe(409);
  });
});

describe('funnel readout access', () => {
  it('is super-admin only', async () => {
    const { venueId } = await setup();
    const res = await SELF.fetch(`${BASE}/api/super/funnel`, { headers: { cookie: await adminCookie(venueId) } });
    expect(res.status).toBe(404);
  });
});

describe('the language switch is not a visit', () => {
  /** The switch's link to `to`, as the browser would follow it. */
  function switchLink(html: string, to: 'pt-PT' | 'en'): string {
    return html.match(new RegExp(`<a href="([^"]+)" hreflang="${to}"`))![1]!.replace(/&amp;/g, '&');
  }

  it('scan -> switch to English -> switch back -> Start is one visit with one scan', async () => {
    const { qrToken } = await setup();
    const scanPage = await (await phone(`/c/${qrToken}`)).text();
    const visit = scanPage.match(/name="visit" value="([^"]+)"/)![1]!;

    const en = await (await phone(switchLink(scanPage, 'en'))).text();
    expect(en).toContain('<html lang="en">');
    // The switched page hands the same visit to its Start form, and on to its own switch.
    expect(en).toContain(`name="visit" value="${visit}"`);
    const back = await (await phone(switchLink(en, 'pt-PT'))).text();
    expect(back).toContain(`name="visit" value="${visit}"`);

    const started = await startFromCourt(qrToken, { visit, lang: 'en' });
    expect(started.token).not.toBeNull();
    await settle(3);
    const all = await steps();
    expect(all.filter((e) => e.step === 'scan')).toHaveLength(1);
    expect(new Set(all.map((e) => e.visit_id))).toEqual(new Set([visit]));
    expect(all.map((e) => e.step)).toEqual(['scan', 'start_attempt', 'started']);
  });

  it('the busy page refreshes with ?r=1 in either language and is still one scan', async () => {
    const { qrToken } = await setup();
    await startFromCourt(qrToken);
    const html = await (await phone(`/c/${qrToken}?lang=en`)).text();
    expect(html).toContain(`url=/c/${qrToken}?r=1&lang=en`);
    await phone(`/c/${qrToken}?r=1&lang=en`);
    await phone(switchLink(html, 'pt-PT'));
    await settle(3);
    expect((await steps()).filter((e) => e.step === 'scan')).toHaveLength(1);
  });

  it('switching language on the match page adds no view', async () => {
    const { qrToken } = await setup();
    const { token } = await playedMatch(qrToken);
    const page = await (await phone(`/m/${token}`)).text();
    const en = await (await phone(switchLink(page, 'en'))).text();
    expect(en).toContain('<html lang="en">');
    await phone(switchLink(en, 'pt-PT'));
    await settle(1);
    await new Promise((r) => setTimeout(r, 100));
    const views = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM funnel_events WHERE step = 'view_ready'`,
    ).first<{ n: number }>();
    expect(views?.n).toBe(1);
    const counted = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM recording_events WHERE kind = 'view'`,
    ).first<{ n: number }>();
    expect(counted?.n).toBe(1);
  });
});
