// The buffer fills before the network comes back.
//
// The requirement is a graceful stop, not a heroic one: seal the recording, keep
// a valid playable file that ends early, and never fill the filesystem. A full
// root partition takes journald and sshd down with it, which turns a network
// outage into a drive to the venue.

import { join } from 'node:path';
import {
  assert,
  assertAtLeast,
  assertEqual,
  fmtBytes,
  sleep,
  type Scenario,
} from '../lib/harness';
import { probe } from '../lib/video';

export const diskBudget: Scenario = {
  name: 'disk-budget',
  what: 'A full buffer seals the match cleanly instead of filling the disk (synthetic feed)',
  estimateMin: 2,
  needsSudo: true,

  async run(ctx) {
    // This scenario tests the BUDGET, not the camera. Capturing the real scene
    // would tie its runtime to how compressible that scene happens to be, and
    // that varies by two orders of magnitude between a dim room and a lit court
    // -- which says nothing about whether sealing works. Swap in a synthetic
    // source with a known, forced rate instead.
    // Snapshot the whole file rather than remembering individual values: the
    // camera command contains a pipe and quotes, and round-tripping it through
    // ssh once left this Pi recording a test pattern instead of the court.
    await ctx.pi.backupEnv();
    // Registered before the env changes: the budget arithmetic below can still
    // fail, and a cleanup registered after it would leave the test pattern behind.
    ctx.onCleanup(async () => {
      await ctx.pi.restoreEnv();
      await ctx.pi.restartAgent();
      await ctx.pi.waitForAgent();
      await ctx.pi.unblockWorker(ctx.config.backend);
      // Verify rather than assume. A restore that quietly does nothing leaves the
      // camera pointed at a test pattern, and every later recording looks fine
      // while containing no padel whatsoever.
      if (await ctx.pi.envContains('testsrc2')) {
        throw new Error(
          'CAPTURE_CMD was NOT restored — the Pi is still set to the synthetic source. ' +
            `Fix it by hand in ${ctx.pi.envFile()} before recording anything real.`,
        );
      }
    });
    await ctx.pi.setEnv('CAPTURE_CMD', ctx.config.mockCaptureCmd);
    ctx.note('capture: synthetic source (~15 MiB/s, camera not used)');

    // A budget is a share of FREE disk, so on a mostly-empty card the percentage
    // has to be tiny to be reached at all.
    const free = await ctx.pi.freeBytes();
    // 40 MiB, not 150. Filling is cheap now that the feed is synthetic, so the
    // ceiling only buys upload time -- 150 MiB meant shipping it all up a venue
    // uplink and pulling it back, which was most of a five-minute run. 40 MiB is
    // still 8 parts at PART_SIZE_MB=5, so it exercises the same thing: warn at
    // 80%, seal at 95%, several published parts, and a valid truncated file.
    const targetBytes = 40 * 1024 * 1024;
    const pct = ((targetBytes / free) * 100).toFixed(6);
    ctx.note(`budget ${fmtBytes(targetBytes)} (${pct}% of ${(free / 1024 ** 3).toFixed(1)} GiB) — fills in ~3s`);

    await ctx.pi.setEnv('DISK_BUDGET_PCT', pct);
    await ctx.pi.restartAgent();
    await ctx.pi.waitForAgent();
    await sleep(15_000);

    const rec = await ctx.api.start(ctx.config.courtId);
    ctx.created.add(rec.id);
    ctx.step(`recording ${rec.id.slice(0, 8)} with a deliberately tiny buffer`);

    await sleep(5_000);
    ctx.step('cutting the network so nothing drains');
    await ctx.pi.blockWorker(ctx.config.backend, 180);

    // ~15 MiB/s in, nothing draining: the ceiling arrives in a few seconds. The
    // window stays generous anyway, because a failure here should read as "it
    // never sealed", not "the test was impatient".
    let sealed = false;
    for (let i = 0; i < 18; i++) {
      await sleep(5_000);
      const manifests = await ctx.pi.spoolManifests();
      const bytes = await ctx.pi.spoolBytes();
      ctx.log(`  ${fmtBytes(bytes)} spooled, ${manifests.length} segment(s)`);
      if (manifests.some((m) => m.sealed === true)) {
        sealed = true;
        break;
      }
      // The filesystem must never be the thing that stops it.
      assertAtLeast(
        await ctx.pi.freeBytes(),
        512 * 1024 * 1024,
        'free disk fell below 512 MiB — the budget did not hold',
      );
    }
    assert(sealed, 'the spool never sealed itself despite exceeding its budget');

    const manifests = await ctx.pi.spoolManifests();
    const truncated = manifests.find((m) => m.truncated === true);
    assert(truncated, `sealed, but not marked truncated: ${JSON.stringify(manifests).slice(0, 300)}`);
    ctx.note(`sealed with reason: ${String(truncated.reason)}`);

    ctx.step('restoring the network so the truncated match can be delivered');
    await ctx.pi.unblockWorker(ctx.config.backend);

    const final = await ctx.api.waitForStatus(rec.id, ['ready', 'failed'], 300_000, (r) =>
      ctx.log(`  ${r.status} — ${fmtBytes(r.bytes)}`),
    );
    // Truncated is not failed: the point is that what was captured stays usable.
    assertEqual(
      final.status,
      'ready',
      `a truncated recording must still complete as a valid file: ${final.error ?? ''}`,
    );
    assertEqual(final.truncated, 1, 'the recording was not marked truncated');
    assert(final.warning, 'a truncated recording should carry a warning explaining why');
    ctx.note(`warning: ${final.warning}`);

    ctx.step('the truncated file must still play');
    const video = join(ctx.artifacts, 'disk-budget.mp4');
    const downloaded = await ctx.api.download(rec.id, video);
    assertEqual(downloaded, final.bytes, 'truncated download does not match its byte count');
    const info = await probe(video);
    assertAtLeast(info.frames, 1, 'the truncated file does not decode');
    ctx.note(`truncated video: ${info.durationSec.toFixed(1)}s, ${info.frames} frames — valid`);
  },
};
