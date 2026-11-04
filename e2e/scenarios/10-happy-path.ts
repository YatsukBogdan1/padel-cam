// The thing the business sells: press start, play, press stop, get the match.

import { join } from 'node:path';
import {
  assert,
  assertAtLeast,
  assertEqual,
  fmtBytes,
  recordFor,
  type Scenario,
} from '../lib/harness';
import { coverage, extractFrame, probe } from '../lib/video';

export const happyPath: Scenario = {
  name: 'happy-path',
  what: 'A normal booking produces a downloadable, playable match',
  estimateMin: 3,

  async run(ctx) {
    const { recording, wallSeconds } = await recordFor(ctx, ctx.config.recordSeconds);

    ctx.step('waiting for upload to finish');
    const final = await ctx.api.waitForStatus(recording.id, ['ready', 'failed'], 180_000, (r) =>
      ctx.log(`  ${r.status} — ${fmtBytes(r.bytes)}`),
    );
    assertEqual(final.status, 'ready', `recording did not become ready: ${final.error ?? ''}`);
    assertEqual(final.error, null, 'a successful recording must have no error');
    assertEqual(final.truncated, 0, 'nothing should be truncated on the happy path');

    ctx.step('downloading');
    const video = join(ctx.artifacts, 'happy-path.mp4');
    const downloaded = await ctx.api.download(recording.id, video);
    // The strongest cheap integrity check there is: if a part had been dropped,
    // R2 would have assembled the object around the gap and these would differ.
    assertEqual(
      downloaded,
      final.bytes,
      'downloaded size does not match the recorded byte count — a part is missing',
    );
    ctx.note(`downloaded ${fmtBytes(downloaded)}`);

    ctx.step('decoding');
    const info = await probe(video);
    assertAtLeast(info.frames, 1, 'the video decoded to zero frames');
    assert(info.width > 0 && info.height > 0, 'video has no dimensions');
    ctx.note(`video: ${info.width}x${info.height} ${info.codec}, ${info.frames} frames, ${info.durationSec.toFixed(1)}s`);

    const got = coverage(info, wallSeconds);
    ctx.note(`coverage: ${(got * 100).toFixed(0)}% of the ${wallSeconds.toFixed(0)}s recording window`);
    assertAtLeast(
      got,
      ctx.config.minDurationRatio,
      `only ${(got * 100).toFixed(0)}% of the recording window is in the file. ` +
        `Frames are being dropped -- on a Pi 5 this is usually the software encoder ` +
        `failing to sustain the configured resolution.`,
    );

    // Nothing automated can tell a padel court from a lens cap, so leave a frame
    // for a human. This is the check that catches a camera nobody aimed.
    const frame = join(ctx.artifacts, 'happy-path-frame.jpg');
    if (await extractFrame(video, Math.min(2, info.durationSec / 2), frame)) {
      ctx.note(`frame saved: ${frame}`);
    }

    ctx.step('spool drained');
    const left = await ctx.pi.spoolParts();
    assertEqual(left, 0, 'parts are still on the Pi after a successful upload');
  },
};
