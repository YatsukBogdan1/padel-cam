// The player flow end to end inside the Worker: scan the court, start, get a
// private link, stop, watch, download -- and every rule about who can reach what.

import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adminCookie,
  BASE,
  bytes,
  deliverFootage,
  eventCounts,
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

/** Start a match, stop it, and deliver `size` bytes so it becomes ready. */
async function readyMatch(qrToken: string, size = 4096) {
  const started = await startFromCourt(qrToken);
  const match = (await getMatchByToken(started.token!))!;
  await SELF.fetch(`${BASE}/m/${started.token}/stop`, { method: 'POST', redirect: 'manual' });
  const [rec] = await segmentsOf(match.session_id);
  const done = await deliverFootage(rec!.id, bytes(size));
  expect(done.status).toBe(200);
  return { ...started, match, recording: rec! };
}

describe('court page (/c/:qrToken)', () => {
  it('does not exist for an unknown sticker', async () => {
    const res = await SELF.fetch(`${BASE}/c/no-such-sticker`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Este código não está ativo');
  });

  it('is dead for a court not assigned to a venue', async () => {
    const { courtId, qrToken } = await setup();
    await env.DB.prepare(`UPDATE courts SET venue_id = NULL WHERE id = ?`).bind(courtId).run();
    expect((await SELF.fetch(`${BASE}/c/${qrToken}`)).status).toBe(404);
  });

  it('says the camera is offline instead of offering a Start that cannot work', async () => {
    const { qrToken } = await setup({ connect: false });
    const html = await (await SELF.fetch(`${BASE}/c/${qrToken}`)).text();
    expect(html).toContain('Câmara sem ligação');
    expect(html).not.toContain('Iniciar gravação');
  });

  it('offers end times on the grid and the consent tick', async () => {
    const { qrToken } = await setup();
    const res = await SELF.fetch(`${BASE}/c/${qrToken}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Iniciar gravação');
    expect(html).toContain('name="consent"');
    expect(html.match(/name="until" value="\d+"/g)?.length).toBeGreaterThan(0);
  });

  it('keeps the page out of referrers and search indexes', async () => {
    const { qrToken } = await setup();
    const res = await SELF.fetch(`${BASE}/c/${qrToken}`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('starting a match', () => {
  it('refuses without consent, and records nothing', async () => {
    const { qrToken } = await setup();
    const started = await startFromCourt(qrToken, { consent: false });
    expect(started.res.status).toBe(400);
    expect(await started.res.text()).toContain('Confirme que avisou os outros jogadores');
    expect(camera!.received('start')).toHaveLength(0);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM recordings`).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('refuses an end time outside 5 minutes .. 3 hours', async () => {
    const { qrToken } = await setup();
    expect((await startFromCourt(qrToken, { until: Date.now() + 60_000 })).res.status).toBe(400);
    expect((await startFromCourt(qrToken, { until: Date.now() + 4 * 3_600_000 })).res.status).toBe(400);
    expect(camera!.received('start')).toHaveLength(0);
  });

  it('starts the camera, hands back a private link, and remembers it on this phone', async () => {
    const { qrToken, courtId } = await setup();
    const until = Date.now() + 90 * 60_000;
    const started = await startFromCourt(qrToken, { until });

    expect(started.res.status).toBe(303);
    expect(started.token).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits, base64url

    // The cookie is scoped to this court's page and unreadable from script.
    expect(started.setCookie).toContain(`Path=/c/${qrToken}`);
    expect(started.setCookie).toContain('HttpOnly');
    expect(started.setCookie).toContain('SameSite=Lax');

    const match = (await getMatchByToken(started.token!))!;
    expect(match.court_id).toBe(courtId);
    expect(match.booked_until).toBe(until);
    expect(match.ends_at).toBe(until);
    expect(match.started_by).toBe('player');

    const [rec] = await segmentsOf(match.session_id);
    expect(rec!.status).toBe('recording');
    const [cmd] = camera!.received('start');
    expect(cmd!.recordingId).toBe(rec!.id);
    expect(cmd!.sessionId).toBe(match.session_id);
  });

  it('schedules auto-stop on the court for the chosen end', async () => {
    const { qrToken, courtId } = await setup();
    const until = Date.now() + 60 * 60_000;
    await startFromCourt(qrToken, { until });
    const { runInDurableObject } = await import('cloudflare:test');
    const stub = env.COURT_CAMERA.get(env.COURT_CAMERA.idFromName(courtId));
    const alarm = await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm());
    expect(alarm).toBe(until);
  });

  it('rolls back when the camera does not acknowledge', async () => {
    const { qrToken } = await setup();
    camera!.ackOk = false;
    const started = await startFromCourt(qrToken);
    expect(started.res.status).toBe(409);
    expect(started.token).toBeNull();
    expect(await started.res.text()).toContain('não começou a gravar');

    // No link to footage that never existed; the failed row stays as evidence.
    const matches = await env.DB.prepare(`SELECT COUNT(*) AS n FROM matches`).first<{ n: number }>();
    expect(matches?.n).toBe(0);
    const rec = await env.DB.prepare(`SELECT status, error FROM recordings`).first<{
      status: string;
      error: string | null;
    }>();
    expect(rec?.status).toBe('failed');
    expect(rec?.error).toBeTruthy();
  });

  it('refuses a second match on a busy court without bothering the camera', async () => {
    const { qrToken } = await setup();
    await startFromCourt(qrToken);
    const second = await startFromCourt(qrToken);
    expect(second.res.status).toBe(409);
    expect(camera!.received('start')).toHaveLength(1);
  });
});

describe('who can reach a match', () => {
  it('sends the phone that started it back to its match on a rescan', async () => {
    const { qrToken } = await setup();
    const started = await startFromCourt(qrToken);
    const res = await SELF.fetch(`${BASE}/c/${qrToken}`, {
      headers: { cookie: started.cookie! },
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/m/${started.token}`);
  });

  it('shows anyone else only that the court is busy -- never the link', async () => {
    const { qrToken } = await setup();
    const started = await startFromCourt(qrToken);
    const html = await (await SELF.fetch(`${BASE}/c/${qrToken}`)).text();
    expect(html).toContain('A gravar até às');
    expect(html).not.toContain(started.token!);
    expect(html).not.toContain('/m/');
    expect(html).not.toContain('Iniciar gravação');
  });

  it('does not let a cookie from one court open a match on another', async () => {
    const a = await setup();
    const started = await startFromCourt(a.qrToken);
    const b = await seedCourt();
    try {
      const res = await SELF.fetch(`${BASE}/c/${b.qrToken}`, {
        headers: { cookie: started.cookie! },
        redirect: 'manual',
      });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(started.token!);
    } finally {
      b.camera?.close();
    }
  });

  it('rejects an unknown or guessed match token', async () => {
    await setup();
    for (const path of ['/m/AAAAAAAAAAAAAAAAAAAAAA', '/m/AAAAAAAAAAAAAAAAAAAAAA/video/1']) {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status).toBe(404);
    }
  });

  it('cannot reach footage through a recording id or the court sticker', async () => {
    const { qrToken } = await setup();
    const { recording } = await readyMatch(qrToken);
    // The operator download needs a session; the court page never links footage.
    expect((await SELF.fetch(`${BASE}/api/recordings/${recording.id}/download`)).status).toBe(401);
    const html = await (await SELF.fetch(`${BASE}/c/${qrToken}`)).text();
    expect(html).not.toContain(recording.id);
    expect(html).not.toContain('/video');
  });
});

describe('the match page (/m/:token)', () => {
  it('is the remote control while recording', async () => {
    const { qrToken } = await setup();
    const started = await startFromCourt(qrToken);
    const res = await SELF.fetch(`${BASE}/m/${started.token}`);
    const html = await res.text();
    expect(html).toContain('A gravar até às');
    expect(html).toContain('Parar a gravação agora');
    expect(html).toContain('Enviar o link ao grupo');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('stops the camera from the link, and records the intent before relaying it', async () => {
    const { qrToken } = await setup();
    const started = await startFromCourt(qrToken);
    const match = (await getMatchByToken(started.token!))!;
    const res = await SELF.fetch(`${BASE}/m/${started.token}/stop`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(res.status).toBe(303);

    const [rec] = await segmentsOf(match.session_id);
    expect(rec!.status).toBe('uploading');
    expect(rec!.stop_requested_at).not.toBeNull();
    expect(camera!.received('stop').map((c) => c.recordingId)).toEqual([rec!.id]);
    expect(await (await SELF.fetch(`${BASE}/m/${started.token}`)).text()).toContain(
      'A preparar o seu vídeo',
    );
  });

  it('serves the finished video and counts the view and the download once each', async () => {
    const { qrToken } = await setup();
    const { token } = await readyMatch(qrToken, 10_000);

    const page = await (await phone(`/m/${token}`)).text();
    expect(page).toContain('<video');
    expect(page).toContain(`/m/${token}/video/1?dl=1`);

    const dl = await phone(`/m/${token}/video/1?dl=1`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    expect((await dl.arrayBuffer()).byteLength).toBe(10_000);

    // Scrubbing and playback are not downloads.
    const seek = await SELF.fetch(`${BASE}/m/${token}/video/1?dl=1`, {
      headers: { range: 'bytes=5000-5999' },
    });
    expect(seek.status).toBe(206);
    await seek.arrayBuffer();
    const play = await SELF.fetch(`${BASE}/m/${token}/video/1`);
    expect(play.headers.get('content-disposition')).toContain('inline');
    await play.arrayBuffer();

    await waitUntil(async () => (await eventCounts()).download === 1);
    const counts = await eventCounts();
    expect(counts).toMatchObject({ view: 1, download: 1 });
  });

  it('counts the share button', async () => {
    const { qrToken } = await setup();
    const started = await startFromCourt(qrToken);
    const res = await SELF.fetch(`${BASE}/m/${started.token}/shared`, { method: 'POST' });
    expect(res.status).toBe(204);
    expect((await eventCounts()).share).toBe(1);
  });

  it('serves nothing for a recording that is not ready', async () => {
    const { qrToken } = await setup();
    const started = await startFromCourt(qrToken);
    expect((await SELF.fetch(`${BASE}/m/${started.token}/video/1`)).status).toBe(409);
    expect((await SELF.fetch(`${BASE}/m/${started.token}/video/2`)).status).toBe(404);
  });
});

describe('free period on the match link', () => {
  it('locks a match started after the free period, and refuses the video itself', async () => {
    const { qrToken, courtId } = await setup();
    await env.DB.prepare(`UPDATE courts SET free_until = ? WHERE id = ?`)
      .bind(Date.now() - 1_000, courtId)
      .run();
    const { token } = await readyMatch(qrToken);

    const page = await (await phone(`/m/${token}`)).text();
    expect(page).toContain('As gravações gratuitas neste campo terminaram');
    expect(page).not.toContain('<video');
    // Enforced on the video, not only by hiding the player.
    expect((await SELF.fetch(`${BASE}/m/${token}/video/1?dl=1`)).status).toBe(402);

    await waitUntil(async () => (await eventCounts()).locked_view === 1);
    expect((await eventCounts()).download).toBeUndefined();
  });

  it('keeps a match free when the free period ends after it started', async () => {
    const { qrToken, courtId } = await setup();
    const { token, recording } = await readyMatch(qrToken);
    // The date is moved to just after this match began: it must stay free.
    await env.DB.prepare(`UPDATE courts SET free_until = ? WHERE id = ?`)
      .bind(recording.started_at + 1, courtId)
      .run();
    expect((await SELF.fetch(`${BASE}/m/${token}/video/1?dl=1`)).status).toBe(200);
  });
});

/** The PT/EN switch's link to `to`, as the browser would follow it. */
function switchLink(html: string, to: 'pt-PT' | 'en'): string {
  const m = html.match(new RegExp(`<a href="([^"]+)" hreflang="${to}"`));
  expect(m, `no switch to ${to}`).not.toBeNull();
  return m![1]!.replace(/&amp;/g, '&');
}

describe('language (pt-PT first, English on request)', () => {
  it('is European Portuguese by default, with a switch to English', async () => {
    const { qrToken } = await setup();
    const html = await (await phone(`/c/${qrToken}`)).text();
    expect(html).toContain('<html lang="pt-PT">');
    expect(html).toContain('Iniciar gravação');
    expect(html).toContain('<nav class="lang">');
    expect(switchLink(html, 'en')).toMatch(new RegExp(`^/c/${qrToken}\\?v=[A-Za-z0-9_-]+&lang=en$`));
  });

  it('is English with ?lang=en, and the start form keeps the choice', async () => {
    const { qrToken } = await setup();
    const html = await (await phone(`/c/${qrToken}?lang=en`)).text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Start recording');
    expect(html).not.toContain('Iniciar gravação');
    expect(html).toContain(`action="/c/${qrToken}/start?lang=en"`);
    expect(switchLink(html, 'pt-PT')).toContain('lang=pt');
  });

  it('follows the browser only when it ranks English above Portuguese', async () => {
    const { qrToken } = await setup();
    const as = async (al: string) =>
      (await phone(`/c/${qrToken}`, { headers: { 'accept-language': al } })).text();
    expect(await as('en-GB,en;q=0.9')).toContain('<html lang="en">');
    expect(await as('pt-PT,pt;q=0.9,en;q=0.8')).toContain('<html lang="pt-PT">');
    expect(await as('en-US;q=0.5,pt;q=0.9')).toContain('<html lang="pt-PT">');
    // An explicit choice beats the browser.
    const html = await (await phone(`/c/${qrToken}?lang=pt`, { headers: { 'accept-language': 'en' } })).text();
    expect(html).toContain('<html lang="pt-PT">');
  });

  it('tells the truth about who can watch, in both languages', async () => {
    const { qrToken } = await setup();
    const pt = await (await phone(`/c/${qrToken}`)).text();
    const en = await (await phone(`/c/${qrToken}?lang=en`)).text();
    expect(pt).toContain('Avisei os outros jogadores de que o jogo vai ser gravado, ninguém se opõe e todos têm 16 anos ou mais.');
    expect(pt).toContain('Veem o vídeo: quem tem o link, a equipa do clube e o operador do serviço.');
    expect(en).toContain("I've told the other players the match will be recorded, nobody objects, and everyone is 16 or older.");
    expect(en).toContain('Who can watch: people with the link, club staff and the service operator.');
    // The false claim and the consent-for-others wording are gone.
    expect(en).not.toContain('Only people you send the link');
    expect(en).not.toContain('agrees');
    const refused = await startFromCourt(qrToken, { consent: false, lang: 'en' });
    expect(await refused.res.text()).toContain('Please confirm you&#39;ve told the other players.');
  });

  it('keeps the court-path cookie unchanged when started in English, and a rescan still returns', async () => {
    const { qrToken } = await setup();
    const started = await startFromCourt(qrToken, { lang: 'en' });
    expect(started.res.status).toBe(303);
    expect(started.res.headers.get('location')).toBe(`/m/${started.token}?lang=en`);
    // Same name, same path -- the language is not in the cookie and does not move it.
    expect(started.cookie).toBe(`padel_match=${started.token}`);
    expect(started.setCookie).toContain(`Path=/c/${qrToken};`);

    for (const [query, location] of [
      ['?lang=en', `${BASE}/m/${started.token}?lang=en`],
      ['?lang=pt', `${BASE}/m/${started.token}?lang=pt`],
      ['', `${BASE}/m/${started.token}`],
    ] as const) {
      const res = await phone(`/c/${qrToken}${query}`, { headers: { cookie: started.cookie! } });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(location);
    }
  });

  it('carries the choice on the match page, but never into the link that is shared', async () => {
    const { qrToken } = await setup();
    const { token } = await startFromCourt(qrToken);
    const pt = await (await phone(`/m/${token}`)).text();
    expect(pt).toContain('<html lang="pt-PT">');
    expect(pt).toContain('Partilhar ou copiar o link');
    expect(switchLink(pt, 'en')).toBe(`/m/${token}?r=1&lang=en`);

    const en = await (await phone(`/m/${token}?lang=en`)).text();
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('Stop recording now');
    expect(en).toContain(`action="/m/${token}/stop?lang=en"`);
    expect(en).toContain(`url=/m/${token}?r=1&lang=en`);
    expect(en).toContain(`'/m/${token}?via=share'`);
    expect(en).not.toContain('via=share&lang');

    const stop = await phone(`/m/${token}/stop?lang=en`, { method: 'POST' });
    expect(stop.headers.get('location')).toBe(`${BASE}/m/${token}?lang=en`);
    expect(await (await phone(`/m/${token}?lang=en`)).text()).toContain('Preparing your video');
  });

  it('translates the ready page and its feedback question', async () => {
    const { qrToken } = await setup();
    const { token } = await readyMatch(qrToken);
    const pt = await (await phone(`/m/${token}`)).text();
    expect(pt).toContain('Transferir vídeo');
    expect(pt).toContain('Foi útil?');
    const en = await (await phone(`/m/${token}?lang=en`)).text();
    expect(en).toContain('Download video');
    expect(en).toContain('Was this useful?');
  });

  it('translates the share page, and its switch is not another view', async () => {
    const { qrToken, venueId } = await setup();
    const { recording } = await readyMatch(qrToken);
    const res = await SELF.fetch(`${BASE}/api/recordings/${recording.id}/share`, {
      method: 'POST',
      headers: { cookie: await adminCookie(venueId) },
    });
    const { token } = (await res.json()) as { token: string };

    const pt = await (await phone(`/s/${token}`)).text();
    expect(pt).toContain('<html lang="pt-PT">');
    expect(pt).toContain('Transferir vídeo');
    const en = await (await phone(switchLink(pt, 'en'))).text();
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('Download video');
    await waitUntil(async () => (await eventCounts()).view === 1);
    await new Promise((r) => setTimeout(r, 100)); // room for a second view to land, if one were counted
    expect((await eventCounts()).view).toBe(1);

    expect(await (await phone('/s/no-such-link?lang=en')).text()).toContain('This link is no longer available');
    expect(await (await phone('/s/no-such-link')).text()).toContain('Este link já não está disponível');
  });
});
