// The operator ends the match while the camera is unreachable.
//
// Two independent failures hide here. The camera must still deliver what it
// captured -- and it must NOT come back and start recording an empty court,
// which is what happens if resume is decided locally instead of by the server.

import { assert, assertEqual, fmtBytes, sleep, type Scenario } from '../lib/harness';

export const stopWhileDown: Scenario = {
  name: 'stop-while-down',
  what: 'A match stopped while the camera was down stays stopped',
  estimateMin: 5,
  needsSudo: true, // stops and starts the unit

  async run(ctx) {
    const rec = await ctx.api.start(ctx.config.courtId);
    ctx.created.add(rec.id);
    const sessionId = rec.session_id;
    assert(sessionId, 'start did not return a session id');
    ctx.step(`recording ${rec.id.slice(0, 8)}`);

    await sleep(ctx.config.recordSeconds * 1000);

    // Hard kill, not `systemctl stop`. A graceful stop makes the agent seal AND
    // drain, and on a fast link the whole upload completes inside the shutdown
    // window -- the row reads `ready` before the operator presses stop, and the
    // scenario has nothing left to test. The case that matters is a camera that
    // vanished with footage still on disk.
    ctx.step('killing the agent so it cannot deliver what it captured');
    await ctx.pi.stopAgentHard();
    ctx.onCleanup(async () => {
      await ctx.pi.startAgent();
      await ctx.pi.waitForAgent();
    });
    await sleep(5_000);

    ctx.step('operator presses stop with the camera offline');
    const stopped = await ctx.api.stop(rec.id);
    // The relay fails -- there is no camera to acknowledge it -- but the intent
    // must be recorded anyway. `stop_requested_at` is stamped before the relay
    // precisely so a camera that was down can read it later.
    ctx.log(`  stop returned ok=${stopped.ok}: ${stopped.body.slice(0, 160)}`);
    const afterStop = await ctx.api.recording(rec.id);
    ctx.note(`row after stop: status=${afterStop.status}, stop_requested_at=${afterStop.stop_requested_at}`);
    assert(
      afterStop.stop_requested_at !== null,
      `stop_requested_at was not stamped (row was "${afterStop.status}"), so a returning ` +
        `camera cannot learn the match ended. Stop said: ${stopped.body.slice(0, 200)}`,
    );

    ctx.step('bringing the camera back');
    await ctx.pi.startAgent();
    await ctx.pi.waitForAgent();
    await sleep(60_000); // connect, report the spool, act on the answer

    ctx.step('the captured footage must still arrive');
    const final = await ctx.api.waitForStatus(rec.id, ['ready', 'failed'], 240_000, (r) =>
      ctx.log(`  ${r.status} — ${fmtBytes(r.bytes)}`),
    );
    assertEqual(
      final.status,
      'ready',
      `footage captured before the camera went down was lost: ${final.error ?? ''}`,
    );

    ctx.step('and the match must NOT have resumed');
    const segments = await ctx.api.segments(sessionId);
    ctx.note(`session has ${segments.length} segment(s): ${segments.map((s) => `${s.segment}:${s.status}`).join(', ')}`);
    for (const s of segments) ctx.created.add(s.id);
    assertEqual(
      segments.length,
      1,
      'the camera opened a new segment for a match the operator had already ended — ' +
        'it would be recording an empty court',
    );
    assert(
      !segments.some((s) => s.status === 'recording'),
      'a segment of a stopped session is still recording',
    );

    ctx.step('and the camera must be idle');
    const journal = await ctx.pi.journal(30);
    assert(
      !/▶ recording/.test(journal.split('stopped by operator').pop() ?? ''),
      'the agent started a new capture after being told the match was over',
    );
  },
};
