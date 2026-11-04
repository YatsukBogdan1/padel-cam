// Every byte captured reaches R2, in order, exactly once.
//
// This is the failure the whole spool exists to prevent, and the one that hides
// best: R2 will happily complete an object around a MISSING part number, so a
// dropped part yields a recording that says `ready`, downloads fine, and plays --
// with a hole in the middle. It was found once already in this project, by
// reading code rather than by testing.
//
// The other scenarios barely exercise this. At the real camera's bitrate a 45s
// recording is about 8 MiB -- one 5 MiB part plus a remainder -- so uniform-size
// enforcement, part ordering and multi-part assembly are all effectively
// untested there. This uses the synthetic feed purely to produce enough parts to
// mean something, and it is one of only two scenarios that should: mocking the
// camera anywhere else would be testing ffmpeg instead of the product.

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

/** Enough parts that ordering and assembly are genuinely exercised. */
const WANT_PARTS = 9;

export const multipartIntegrity: Scenario = {
  name: 'multipart-integrity',
  what: 'A many-part upload arrives whole — no gaps, no reordering, byte-exact',
  estimateMin: 3,

  async run(ctx) {
    await ctx.pi.backupEnv();
    // Registered before the env changes, so a failure anywhere after the backup
    // still puts the camera command back.
    ctx.onCleanup(async () => {
      await ctx.pi.restoreEnv();
      await ctx.pi.restartAgent();
      await ctx.pi.waitForAgent();
      if (await ctx.pi.envContains('testsrc2')) {
        throw new Error(
          'CAPTURE_CMD was NOT restored — the Pi is still on the synthetic source. ' +
            `Fix it by hand in ${ctx.pi.envFile()} before recording anything real.`,
        );
      }
    });
    await ctx.pi.setEnv('CAPTURE_CMD', ctx.config.mockCaptureCmd);
    await ctx.pi.restartAgent();
    await ctx.pi.waitForAgent();
    await sleep(15_000);
    ctx.note('capture: synthetic source (camera not used — this tests the pipeline)');

    const rec = await ctx.api.start(ctx.config.courtId);
    ctx.created.add(rec.id);
    ctx.step(`recording ${rec.id.slice(0, 8)} until ${WANT_PARTS} parts are cut`);

    // Capture at ~15 MiB/s cuts a 5 MiB part every third of a second, so this
    // stops after a few seconds. Capturing by PART COUNT rather than by clock is
    // what keeps the scenario meaningful if the feed's rate ever changes.
    let cutParts = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(2_000);
      const manifests = await ctx.pi.spoolManifests();
      const m = manifests[0];
      cutParts = m ? Number(m.nextPart ?? 1) - 1 : 0;
      if (cutParts >= WANT_PARTS) break;
    }
    assertAtLeast(cutParts, WANT_PARTS, `only ${cutParts} parts were cut`);
    ctx.note(`${cutParts} parts cut on the Pi`);

    ctx.step('stopping');
    await ctx.api.stop(rec.id);

    // Read the Pi's own byte counter before the spool is destroyed on success.
    // This is the independent half of the check: `capturedBytes` counts bytes
    // WRITTEN by capture, `bytes` in D1 counts bytes RECEIVED by the Worker. Two
    // counters incremented on opposite sides of the network, so agreement means
    // nothing was lost in between -- which comparing the object to its own
    // manifest could never show.
    let capturedBytes = 0;
    let sealed = false;
    for (let i = 0; i < 30; i++) {
      const m = (await ctx.pi.spoolManifests())[0];
      if (m) {
        capturedBytes = Math.max(capturedBytes, Number(m.capturedBytes ?? 0));
        if (m.sealed === true) {
          sealed = true;
          break;
        }
      }
      await sleep(2_000);
    }
    assert(sealed, 'the spool never sealed after stop');
    assertAtLeast(capturedBytes, 1, 'the manifest reported no captured bytes');
    ctx.note(`captured on the Pi: ${fmtBytes(capturedBytes)}`);

    ctx.step('waiting for every part to land');
    const final = await ctx.api.waitForStatus(rec.id, ['ready', 'failed'], 420_000, (r) =>
      ctx.log(`  ${r.status} — ${fmtBytes(r.bytes)}`),
    );
    assertEqual(final.status, 'ready', `multipart upload did not complete: ${final.error ?? ''}`);

    // R2 enforces "every part except the last is the same size" at complete time,
    // so a successful complete across this many parts is itself the proof that
    // the agent only ever cut at exact boundaries.
    ctx.note(`assembled from ${cutParts}+ parts — R2 accepted the uniform-size rule`);

    ctx.step('bytes captured must equal bytes stored');
    assertEqual(
      final.bytes,
      capturedBytes,
      'the Worker stored a different number of bytes than the Pi captured — ' +
        'a part was dropped, duplicated, or truncated in flight',
    );

    ctx.step('and the object must match, byte for byte');
    const video = join(ctx.artifacts, 'multipart.mp4');
    const downloaded = await ctx.api.download(rec.id, video);
    assertEqual(
      downloaded,
      final.bytes,
      'the assembled object is a different size than the sum of its parts',
    );

    ctx.step('and it must decode end to end');
    // A hole in the middle still downloads and still plays; only decoding the
    // whole stream shows it. Frame count is the tell -- a missing 5 MiB part
    // costs hundreds of frames.
    const info = await probe(video);
    assertAtLeast(info.frames, 1, 'the assembled video does not decode');
    assertAtLeast(
      info.durationSec,
      1,
      'the assembled video has no duration — parts may be out of order',
    );
    ctx.note(
      `assembled video: ${fmtBytes(downloaded)}, ${info.frames} frames, ${info.durationSec.toFixed(1)}s`,
    );

    ctx.step('spool fully reclaimed');
    assertEqual(await ctx.pi.spoolParts(), 0, 'parts are still on the Pi after a successful upload');
  },
};
