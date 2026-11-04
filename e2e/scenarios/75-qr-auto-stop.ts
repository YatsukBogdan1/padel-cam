// Nobody presses stop. The match must end at the chosen time on its own, on the
// real camera -- or the next group is filmed and the Pi's disk fills overnight.

import { Phone, SuperApi } from '../lib/api';
import { assert, assertBetween, assertEqual, sleep, type Scenario } from '../lib/harness';
import { recordingStartedSince } from './70-qr-match';

/** The shortest match the server accepts is 5 minutes. */
const MATCH_MS = 5 * 60_000 + 20_000;

export const qrAutoStop: Scenario = {
  name: 'qr-auto-stop',
  what: 'A match started from the sticker stops by itself at the chosen end time',
  estimateMin: 7,

  async run(ctx) {
    const qr = await new SuperApi(ctx.api).qrToken(ctx.config.courtId);
    const phone = new Phone(ctx.config.backend);

    const until = Date.now() + MATCH_MS;
    ctx.step(`starting a match that ends at ${new Date(until).toISOString().slice(11, 19)}Z`);
    const t0 = Date.now() - 2_000;
    const started = await phone.start(qr, until);
    assertEqual(started.status, 303, `Start failed: ${started.body}`);
    const rec = await recordingStartedSince(ctx, t0);

    ctx.step('waiting -- nobody touches anything');
    while (Date.now() < until - 15_000) {
      const r = await ctx.api.recording(rec.id);
      assertEqual(r.status, 'recording', 'the match ended before its time');
      ctx.log(`  recording, ${Math.round((until - Date.now()) / 1000)}s to go`);
      await sleep(30_000);
    }

    // The alarm fires on time; the cron backstop is up to 5 minutes later. Allow
    // the alarm plus the stop handshake, and fail if only the backstop caught it.
    const final = await ctx.api.waitForStatus(rec.id, ['ready', 'failed'], 180_000, (r) =>
      ctx.log(`  ${r.status}`),
    );
    assertEqual(final.status, 'ready', `auto-stopped match did not become ready: ${final.error ?? ''}`);
    assert(final.stop_requested_at !== null, 'stop was never recorded on the row');
    const lateBy = (final.stop_requested_at! - until) / 1000;
    ctx.note(`auto-stop fired ${lateBy.toFixed(1)}s after the end time`);
    assertBetween(lateBy, -1, 60, 'auto-stop did not fire at the end time (alarm missed?)');

    ctx.step('the camera really stopped');
    await sleep(10_000);
    assertEqual(await ctx.pi.spoolParts(), 0, 'parts are still on the Pi -- is it still capturing?');
    const page = await phone.page(`/m/${started.token}`);
    assert(page.html.includes('<video'), 'the auto-stopped match has no player');
  },
};
