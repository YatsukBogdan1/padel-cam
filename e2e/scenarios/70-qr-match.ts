// The player flow on the real camera: scan the sticker, press Start, send the
// link, stop from the phone, download through the link. Exactly what a group at
// the court does, with no operator anywhere.

import { join } from 'node:path';
import { Phone, SuperApi, type Recording } from '../lib/api';
import { assert, assertAtLeast, assertEqual, fmtBytes, sleep, type Ctx, type Scenario } from '../lib/harness';
import { coverage, probe } from '../lib/video';

/** The recording a phone just started, found through the operator view. */
export async function recordingStartedSince(ctx: Ctx, since: number): Promise<Recording> {
  const recs = await ctx.api.recordings();
  const rec = recs.find((r) => r.court_id === ctx.config.courtId && r.started_at >= since);
  if (!rec) throw new Error('no recording appeared for the court after Start');
  ctx.created.add(rec.id);
  return rec;
}

export const qrMatch: Scenario = {
  name: 'qr-match',
  what: 'A group records its own match from the court sticker and gets the video by link',
  estimateMin: 3,

  async run(ctx) {
    const sup = new SuperApi(ctx.api);
    const qr = await sup.qrToken(ctx.config.courtId);
    const before = await sup.engagement(ctx.config.courtId);
    const funnelBefore = (await sup.funnel(ctx.config.courtId)) ?? {};

    const phone = new Phone(ctx.config.backend);
    const stranger = new Phone(ctx.config.backend);

    ctx.step('scanning the sticker');
    const court = await phone.page(`/c/${qr}`);
    assertEqual(court.status, 200, 'court page did not load');
    assert(court.html.includes('Start recording'), 'court page offers no Start -- is the camera online?');
    assertEqual(court.headers.get('referrer-policy'), 'no-referrer', 'court page leaks its URL as a referrer');
    // From this page, not a second fetch: every court page load is a scan.
    const options = [...court.html.matchAll(/name="until" value="(\d+)"/g)].map((m) => Number(m[1]));
    assert(options.length > 0, 'no end times offered');
    for (const at of options) {
      assert(new Date(at).getUTCMinutes() % 15 === 0, `end time ${new Date(at).toISOString()} is off the grid`);
    }

    ctx.step('pressing Start');
    const t0 = Date.now() - 2_000;
    const started = await phone.start(qr, options[options.length - 1]!);
    assertEqual(started.status, 303, `Start did not redirect to the match: ${started.body}`);
    assert(started.token, 'no match link came back');
    assert(phone.cookie.startsWith('padel_match='), 'the phone was not given its match cookie');
    const rec = await recordingStartedSince(ctx, t0);
    const wallStart = Date.now();

    ctx.step('checking who can reach it');
    const busy = await stranger.page(`/c/${qr}`);
    assert(busy.html.includes('Recording until'), 'a second phone was not told the court is busy');
    assert(!busy.html.includes(started.token), 'the court page leaked the match link to a stranger');
    const back = await phone.page(`/c/${qr}`);
    assertEqual(back.status, 303, 'rescanning from the same phone did not return to the match');
    assert(back.location?.endsWith(`/m/${started.token}`), `rescan went to ${back.location}`);
    const second = await stranger.start(qr, options[0]!);
    assertEqual(second.status, 409, 'a second group could start over a live match');

    const live = await phone.page(`/m/${started.token}`);
    assert(live.html.includes('Recording until'), 'match page does not show the live recording');
    assertEqual(await phone.shared(started.token), 204, 'share tap was not accepted');

    ctx.step(`recording ${ctx.config.recordSeconds}s`);
    await sleep(ctx.config.recordSeconds * 1000);

    ctx.step('stopping from the phone');
    assertEqual(await phone.stop(started.token), 303, 'stop from the match link failed');
    const wallSeconds = (Date.now() - wallStart) / 1000;
    const final = await ctx.api.waitForStatus(rec.id, ['ready', 'failed'], 180_000, (r) =>
      ctx.log(`  ${r.status} — ${fmtBytes(r.bytes)}`),
    );
    assertEqual(final.status, 'ready', `recording did not become ready: ${final.error ?? ''}`);

    ctx.step('downloading through the link');
    const ready = await phone.page(`/m/${started.token}`);
    assert(ready.html.includes('<video'), 'match page has no player once ready');
    const video = join(ctx.artifacts, 'qr-match.mp4');
    const dl = await phone.download(started.token, 1, video);
    assertEqual(dl.status, 200, 'download through the match link failed');
    assertEqual(dl.bytes, final.bytes, 'link download size differs from the recording -- a part is missing');

    const info = await probe(video);
    assertAtLeast(info.frames, 1, 'the downloaded match decoded to zero frames');
    const got = coverage(info, wallSeconds);
    ctx.note(`qr match: ${fmtBytes(dl.bytes)}, ${(got * 100).toFixed(0)}% of the window`);
    assertAtLeast(got, ctx.config.minDurationRatio, 'the match video is missing much of the recording window');

    ctx.step('readout counted it');
    const after = await sup.engagement(ctx.config.courtId);
    assertEqual(
      (after?.player_matches ?? 0) - (before?.player_matches ?? 0),
      1,
      'the player-started match was not counted',
    );
    assertEqual(
      (after?.shared_matches ?? 0) - (before?.shared_matches ?? 0),
      1,
      'the share tap was not counted',
    );
    assertAtLeast(
      (after?.downloads ?? 0) - (before?.downloads ?? 0),
      1,
      'the link download was not counted',
    );

    ctx.step('the funnel followed the phone through every step');
    const funnelAfter = (await sup.funnel(ctx.config.courtId)) ?? {};
    // What this scenario did: the phone scanned (ready) and later rescanned
    // (returning); the stranger scanned (busy) and tried to start over it.
    const expected: Record<string, number> = {
      scans_ready: 1,
      scans_busy: 1,
      scans_returning: 1,
      start_attempts: 2,
      started: 1,
      shared: 1,
      returned_ready: 1,
      downloaded: 1,
    };
    for (const [key, n] of Object.entries(expected)) {
      assertEqual(
        (funnelAfter[key] ?? 0) - (funnelBefore[key] ?? 0),
        n,
        `funnel step "${key}" is off for this match`,
      );
    }
  },
};
