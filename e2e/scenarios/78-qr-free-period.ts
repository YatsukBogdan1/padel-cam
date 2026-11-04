// After the free period, a player's link must show the match is theirs but not
// hand over the video -- enforced on the video itself, not only on the page.

import { join } from 'node:path';
import { Phone, SuperApi } from '../lib/api';
import { assert, assertEqual, sleep, type Scenario } from '../lib/harness';
import { recordingStartedSince } from './70-qr-match';

export const qrFreePeriod: Scenario = {
  name: 'qr-free-period',
  what: 'Matches after the free period are locked on the player link',
  estimateMin: 2,

  async run(ctx) {
    const sup = new SuperApi(ctx.api);
    const courtId = ctx.config.courtId;
    const previous = (await sup.overview()).courts.find((c) => c.courtId === courtId)?.freeUntil ?? null;
    ctx.onCleanup(async () => {
      await sup.setFreeUntil(courtId, previous);
    });
    await sup.setFreeUntil(courtId, Date.now() - 1_000);

    const qr = await sup.qrToken(courtId);
    const phone = new Phone(ctx.config.backend);
    const options = await phone.endOptions(qr);
    const t0 = Date.now() - 2_000;
    const started = await phone.start(qr, options[options.length - 1]!);
    assertEqual(started.status, 303, `Start failed: ${started.body}`);
    const rec = await recordingStartedSince(ctx, t0);

    await sleep(15_000);
    await phone.stop(started.token!);
    const final = await ctx.api.waitForStatus(rec.id, ['ready', 'failed'], 120_000);
    assertEqual(final.status, 'ready', 'locked match should still be recorded');

    const page = await phone.page(`/m/${started.token}`);
    assert(page.html.includes('Free recordings at this court have ended'), 'page is not locked');
    assert(!page.html.includes('<video'), 'locked page still embeds the player');
    const dl = await phone.download(started.token!, 1, join(ctx.artifacts, 'locked.mp4'));
    assertEqual(dl.status, 402, 'the video itself was served past the free period');
  },
};
