// The venue's WiFi drops mid-match.
//
// This is the scenario the spool exists for. Before it, capture paused once
// 40 MiB accumulated in RAM -- roughly 32 seconds at 10 Mbit/s -- which stalled
// ffmpeg and rpicam and LOST the footage. The requirement is not that the upload
// survives; it is that the video does, with no gap in the middle.

import { join } from 'node:path';
import {
  assert,
  assertAtLeast,
  assertEqual,
  fmtBytes,
  sleep,
  type Scenario,
} from '../lib/harness';
import { coverage, probe } from '../lib/video';

export const networkLoss: Scenario = {
  name: 'network-loss',
  what: 'A WiFi outage mid-match defers footage instead of losing it',
  estimateMin: 5,
  needsSudo: true,

  async run(ctx) {
    const outageSec = 60;
    const total = Math.max(ctx.config.recordSeconds, outageSec + 40);

    const rec = await ctx.api.start(ctx.config.courtId);
    ctx.created.add(rec.id);
    ctx.step(`recording ${rec.id.slice(0, 8)}; will cut the network for ${outageSec}s`);
    const startedAt = Date.now();

    // Restoration is scheduled on the Pi before the block goes in, so the rule
    // lifts even if this process dies.
    ctx.onCleanup(async () => {
      await ctx.pi.unblockWorker(ctx.config.backend);
    });

    await sleep(15_000);
    const bytesBefore = await ctx.pi.spoolBytes();

    ctx.step('cutting the Pi off from the Worker');
    await ctx.pi.blockWorker(ctx.config.backend, outageSec);
    assert(
      await ctx.pi.workerBlocked(ctx.config.backend),
      'the firewall rule did not take effect — the Pi can still reach the Worker',
    );

    // Capture must keep running with nowhere to send anything. Growth in BYTES is
    // the proof. Counting published parts instead made this depend on crossing
    // 5 MiB boundaries, so a dim scene at ~84 KiB/s crossed only one in 60s and
    // the scenario reported "capture stopped" while the spool was visibly filling.
    // Bytes are what capture actually produces; parts are a quantised proxy for it.
    let peakBytes = bytesBefore;
    for (let i = 0; i < outageSec / 10; i++) {
      await sleep(10_000);
      const parts = await ctx.pi.spoolParts();
      const bytes = await ctx.pi.spoolBytes();
      peakBytes = Math.max(peakBytes, bytes);
      ctx.log(`  offline ${(i + 1) * 10}s — ${parts} parts spooled, ${fmtBytes(bytes)}`);
    }
    // 1 MiB over a 60s outage is ~17 KiB/s: far below any real capture, but far
    // above the zero that a stalled pipeline would produce.
    assertAtLeast(
      peakBytes - bytesBefore,
      1024 * 1024,
      'the spool did not grow during the outage — capture stopped instead of buffering',
    );
    ctx.note(
      `buffered ${fmtBytes(peakBytes - bytesBefore)} while offline ` +
        `(${fmtBytes(bytesBefore)} → ${fmtBytes(peakBytes)})`,
    );

    ctx.step('restoring the network');
    await ctx.pi.unblockWorker(ctx.config.backend);
    assert(
      !(await ctx.pi.workerBlocked(ctx.config.backend)),
      'the Pi still cannot reach the Worker after unblocking',
    );

    await sleep(total * 1000 - (Date.now() - startedAt));
    const wallSeconds = (Date.now() - startedAt) / 1000;

    ctx.step('stopping');
    await ctx.api.stop(rec.id);

    // Generous: the backlog accumulated during the outage still has to go up a
    // venue's uplink after capture ends.
    const final = await ctx.api.waitForStatus(rec.id, ['ready', 'failed'], 360_000, (r) =>
      ctx.log(`  ${r.status} — ${fmtBytes(r.bytes)}`),
    );
    assertEqual(final.status, 'ready', `recording did not survive the outage: ${final.error ?? ''}`);

    ctx.step('verifying the footage has no hole in it');
    const video = join(ctx.artifacts, 'network-loss.mp4');
    const downloaded = await ctx.api.download(rec.id, video);
    assertEqual(downloaded, final.bytes, 'downloaded size does not match — a part was lost');

    const info = await probe(video);
    const got = coverage(info, wallSeconds);
    ctx.note(
      `coverage across a ${outageSec}s outage: ${(got * 100).toFixed(0)}% ` +
        `(${info.durationSec.toFixed(1)}s of ${wallSeconds.toFixed(0)}s)`,
    );
    // The whole point: the outage must not show up as missing video.
    assertAtLeast(
      got,
      ctx.config.minDurationRatio,
      `the outage cost footage — only ${(got * 100).toFixed(0)}% of the window is in the file`,
    );

    assertEqual(await ctx.pi.spoolParts(), 0, 'the spool did not fully drain');
  },
};
