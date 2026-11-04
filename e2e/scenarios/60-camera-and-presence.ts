// Two failures that must be diagnosable from the browser rather than from a
// journal at the venue: something else is holding the camera, and the camera is
// gone entirely.

import { assert, assertEqual, sleep, type Scenario } from '../lib/harness';

/**
 * The camera is single-access. An `rpicam-vid` preview left running after
 * someone aimed it is the usual culprit, and capture then exits immediately.
 * The operator must see why, not just "no data".
 */
export const cameraContention: Scenario = {
  name: 'camera-contention',
  what: 'A camera held by another process fails visibly, with the reason',
  estimateMin: 3,

  async run(ctx) {
    ctx.step('holding the camera with a competing process');
    await ctx.pi.holdCamera(90);
    ctx.onCleanup(async () => {
      await ctx.pi.releaseCamera();
    });
    await sleep(5_000);

    const started = await ctx.api.tryStart(ctx.config.courtId);
    if (started.recording) ctx.created.add(started.recording.id);

    // Start may succeed -- the agent acknowledges before spawning capture, since
    // the ack answers "did a live agent hear this". The failure surfaces when
    // capture cannot acquire the device.
    if (!started.ok) {
      // A refusal is a legitimate outcome -- but only if it refuses for the right
      // reason. Passing on ANY error let a 500 ("Can't call WebSocket send()
      // after close()") count as success, which is the same false-pass this
      // suite exists to catch.
      const why = started.error ?? '';
      assert(
        !/internal error|500/i.test(why),
        `start failed with a server error rather than a clean refusal: ${why.slice(0, 300)}`,
      );
      assert(
        /camera|busy|acquire|already recording|did not respond|acknowledge/i.test(why),
        `start was refused, but not for a reason an operator can act on: ${why.slice(0, 300)}`,
      );
      ctx.note(`start cleanly refused: ${why.slice(0, 200)}`);
      return;
    }

    const rec = started.recording!;
    ctx.step(`start acknowledged (${rec.id.slice(0, 8)}); capture should now fail`);
    const final = await ctx.api.waitForStatus(rec.id, ['failed', 'ready'], 120_000, (r) =>
      ctx.log(`  ${r.status}`),
    );

    assertEqual(
      final.status,
      'failed',
      'capture succeeded while another process held the camera, which should be impossible',
    );
    assert(final.error, 'a failed recording must record WHY, or it is undiagnosable remotely');
    ctx.note(`reported reason: ${final.error.slice(0, 220)}`);
    // The value of the stderr tail is that it names the real cause.
    assert(
      /camera|device|busy|acquire|resource/i.test(final.error),
      `the failure reason does not mention the camera, so an operator cannot act on it: ${final.error}`,
    );
  },
};

/**
 * Presence is derived from heartbeats, never latched. A Pi that loses power
 * never sends a close, so a stored flag would read online forever -- which is
 * exactly how a court sat "online" for twelve hours after it fell off the net.
 */
export const presence: Scenario = {
  name: 'presence',
  what: 'A camera that stops heartbeating is reported offline on its own',
  estimateMin: 4,
  needsSudo: true, // stops and starts the unit

  async run(ctx) {
    const before = await ctx.api.court(ctx.config.courtId);
    assert(before?.online, 'court was not online at the start of the presence test');

    ctx.step('stopping the agent');
    await ctx.pi.stopAgent();
    ctx.onCleanup(async () => {
      await ctx.pi.startAgent();
      await ctx.pi.waitForAgent();
      await sleep(20_000);
    });

    // PRESENCE_TTL_MS is 90s; allow a margin for the last beat's timing.
    ctx.step('waiting for presence to expire (should be under ~2 minutes)');
    const deadline = Date.now() + 180_000;
    let offline = false;
    while (Date.now() < deadline) {
      await sleep(10_000);
      const court = await ctx.api.court(ctx.config.courtId);
      ctx.log(`  online=${court?.online}`);
      if (court && !court.online) {
        offline = true;
        ctx.note(`went offline after ${Math.round((Date.now() - (deadline - 180_000)) / 1000)}s`);
        break;
      }
    }
    assert(offline, 'the court still reads online with no agent running — presence is latched');

    ctx.step('a start against an offline court must fail, not pretend');
    const attempt = await ctx.api.tryStart(ctx.config.courtId);
    assert(
      !attempt.ok,
      'start succeeded against a camera that is not there — the operator would see a ' +
        'recording light for a match nobody is capturing',
    );
    // A refused start still leaves a `failed` row; reclaim it so runs do not
    // accumulate dead entries on the operator's page.
    if (attempt.recording) ctx.created.add(attempt.recording.id);
    if (attempt.recordingId) ctx.created.add(attempt.recordingId);
    ctx.note(`start correctly refused: ${attempt.error?.slice(0, 160)}`);

    ctx.step('bringing it back');
    await ctx.pi.startAgent();
    await ctx.pi.waitForAgent();
    await sleep(25_000);
    const after = await ctx.api.court(ctx.config.courtId);
    assert(after?.online, 'the court did not come back online after the agent restarted');
  },
};
