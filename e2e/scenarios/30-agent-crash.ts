// The agent dies mid-match and systemd restarts it.
//
// Two things must hold: the footage captured before the crash still arrives, and
// the match carries on as a second segment. Before the spool, both were lost --
// everything buffered was in RAM, and nothing knew a match had been running.

import { join } from 'node:path';
import { assert, assertAtLeast, assertEqual, fmtBytes, sleep, type Scenario } from '../lib/harness';
import { probe } from '../lib/video';

export const agentCrash: Scenario = {
  name: 'agent-crash',
  what: 'A crash mid-match keeps the first half and resumes the second',
  estimateMin: 5,

  async run(ctx) {
    const rec = await ctx.api.start(ctx.config.courtId);
    ctx.created.add(rec.id);
    const sessionId = rec.session_id;
    assert(sessionId, 'start did not return a session id — segments cannot work without one');
    ctx.step(`recording ${rec.id.slice(0, 8)} in session ${sessionId.slice(0, 8)}`);

    await sleep(ctx.config.recordSeconds * 1000);

    ctx.step('killing the agent (systemd will restart it)');
    await ctx.pi.killAgent();
    await ctx.pi.waitForAgent();
    ctx.step('agent back; waiting for it to reconnect and be told what to do');
    await sleep(45_000);

    ctx.step('checking the session');
    const segments = await ctx.api.segments(sessionId);
    ctx.note(`session has ${segments.length} segment(s): ${segments.map((s) => `${s.segment}:${s.status}`).join(', ')}`);

    assertAtLeast(segments.length, 2, 'the match did not resume as a second segment after the crash');

    const first = segments[0]!;
    const second = segments[1]!;
    ctx.created.add(second.id);

    ctx.step('segment 1 must have survived the crash');
    const settled = await ctx.api.waitForStatus(first.id, ['ready', 'failed'], 180_000, (r) =>
      ctx.log(`  segment 1: ${r.status} — ${fmtBytes(r.bytes)}`),
    );
    assertEqual(
      settled.status,
      'ready',
      `footage captured before the crash was lost: ${settled.error ?? ''}`,
    );
    assertAtLeast(settled.bytes, 1, 'segment 1 completed with no bytes');

    const video = join(ctx.artifacts, 'crash-segment-1.mp4');
    const downloaded = await ctx.api.download(first.id, video);
    assertEqual(downloaded, settled.bytes, 'segment 1 download does not match its byte count');
    const info = await probe(video);
    assertAtLeast(info.frames, 1, 'segment 1 decoded to zero frames');
    ctx.note(`segment 1 recovered: ${info.durationSec.toFixed(1)}s, ${info.frames} frames`);

    ctx.step('segment 2 must be live');
    assertEqual(second.status, 'recording', 'segment 2 is not recording');
    assertEqual(second.session_id, sessionId, 'segment 2 is not in the same session');

    ctx.step('stopping the resumed match');
    await ctx.api.stop(second.id);
    const secondFinal = await ctx.api.waitForStatus(second.id, ['ready', 'failed'], 180_000);
    assertEqual(secondFinal.status, 'ready', `segment 2 did not complete: ${secondFinal.error ?? ''}`);
    ctx.note(`segment 2: ${fmtBytes(secondFinal.bytes)}`);
  },
};
