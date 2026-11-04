// A real power cut, as close as software can get to one.
//
// `reboot -f` skips shutdown entirely: no unmount, no sync, nothing flushed.
// That is the only way to test the spool's fsync discipline honestly -- `kill -9`
// leaves the page cache intact, so a spool that never called fsync would still
// pass an agent-crash test and then lose the match the first time the power
// actually went at a venue.
//
// Opt-in (`--include-slow`) because the Pi is gone for a minute or two.

import { join } from 'node:path';
import { assert, assertAtLeast, assertEqual, fmtBytes, sleep, type Scenario } from '../lib/harness';
import { probe } from '../lib/video';

export const hardReboot: Scenario = {
  name: 'hard-reboot',
  what: 'An unclean power cut keeps the footage already written to the card',
  estimateMin: 8,
  slow: true,
  needsSudo: true,

  async run(ctx) {
    const rec = await ctx.api.start(ctx.config.courtId);
    ctx.created.add(rec.id);
    const sessionId = rec.session_id;
    assert(sessionId, 'start did not return a session id');
    ctx.step(`recording ${rec.id.slice(0, 8)}; letting it build a real buffer`);

    // Long enough to have published several parts, so there is something on the
    // card that must survive.
    await sleep(Math.max(ctx.config.recordSeconds, 60) * 1000);
    const partsBefore = await ctx.pi.spoolParts();
    const manifestsBefore = await ctx.pi.spoolManifests();
    ctx.note(`before the cut: ${partsBefore} part(s) pending on disk`);
    const uploadedBefore = Number(
      (manifestsBefore[0]?.parts as unknown[] | undefined)?.length ?? 0,
    );
    ctx.note(`before the cut: ${uploadedBefore} part(s) already confirmed by R2`);

    ctx.step('pulling the plug (reboot -f — no sync, no unmount)');
    await ctx.pi.hardReboot();

    ctx.step('waiting for the Pi to come back');
    await ctx.pi.waitForBoot();
    ctx.note('Pi is back');
    await ctx.pi.waitForAgent(120_000);

    ctx.step('filesystem must be intact');
    const fsck = await ctx.pi.sh('dmesg | grep -iE "ext4.*(error|corrupt)" | tail -5');
    assert(
      !/error|corrupt/i.test(fsck.stdout),
      `the filesystem reported errors after the unclean reboot:\n${fsck.stdout}`,
    );

    ctx.step('the spool must have survived on the card');
    const manifests = await ctx.pi.spoolManifests();
    ctx.log(`  ${manifests.length} segment(s) recovered from disk`);

    // Give the agent time to reconnect, declare what it holds, and act on the answer.
    await sleep(60_000);

    ctx.step('segment 1 must reach a terminal state with real video in it');
    const settled = await ctx.api.waitForStatus(rec.id, ['ready', 'failed'], 300_000, (r) =>
      ctx.log(`  ${r.status} — ${fmtBytes(r.bytes)}`),
    );
    assertEqual(
      settled.status,
      'ready',
      `footage written to the card before the power cut was lost: ${settled.error ?? ''}`,
    );
    assertAtLeast(settled.bytes, 1, 'the recovered recording has no bytes');

    const video = join(ctx.artifacts, 'hard-reboot-segment-1.mp4');
    const downloaded = await ctx.api.download(rec.id, video);
    assertEqual(downloaded, settled.bytes, 'recovered download does not match its byte count');
    const info = await probe(video);
    assertAtLeast(info.frames, 1, 'the recovered file does not decode — fsync discipline failed');
    ctx.note(`recovered ${info.durationSec.toFixed(1)}s / ${info.frames} frames across a power cut`);

    ctx.step('and the match should have resumed as a new segment');
    const segments = await ctx.api.segments(sessionId);
    for (const s of segments) ctx.created.add(s.id);
    ctx.note(`session: ${segments.map((s) => `${s.segment}:${s.status}`).join(', ')}`);
    assertAtLeast(segments.length, 2, 'the match did not resume after the reboot');

    const live = segments.find((s) => s.status === 'recording');
    if (live) {
      await ctx.api.stop(live.id);
      await ctx.api.waitForStatus(live.id, ['ready', 'failed'], 180_000);
    }
  },
};
