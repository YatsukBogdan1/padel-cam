// Is this camera capable of the job at all?
//
// Everything downstream assumes a working camera, a reachable Worker and an
// encoder that keeps up. When one of those is false, every later scenario fails
// in a confusing way, so they are checked here first and reported plainly.

import { assert, assertAtLeast, type Scenario } from '../lib/harness';

export const preflight: Scenario = {
  name: 'preflight',
  what: 'The camera, the agent and the Worker are all present and talking',
  estimateMin: 2,

  async run(ctx) {
    ctx.step('Pi reachable over SSH');
    assert(await ctx.pi.reachable(), `cannot ssh to ${ctx.config.pi}`);

    ctx.step('camera detected');
    const cameras = await ctx.pi.sh('rpicam-hello --list-cameras 2>&1');
    assert(
      /\d\s*:\s*\w+/.test(cameras.stdout),
      `no camera detected on the Pi:\n${cameras.stdout.slice(0, 400)}`,
    );
    const sensor = /^\d\s*:\s*(\w+)/m.exec(cameras.stdout)?.[1] ?? 'unknown';
    ctx.note(`sensor: ${sensor}`);

    ctx.step('capture tooling present');
    const tools = await ctx.pi.sh('command -v ffmpeg rpicam-vid node; node --version');
    assert(tools.stdout.includes('ffmpeg'), 'ffmpeg is missing on the Pi');
    assert(tools.stdout.includes('rpicam-vid'), 'rpicam-vid is missing on the Pi');
    const nodeVersion = /v(\d+)\.\d+\.\d+/.exec(tools.stdout);
    assert(nodeVersion, 'could not read node version on the Pi');
    // fs.promises.statfs, which the spool uses for its disk budget, landed in 18.15.
    assertAtLeast(Number(nodeVersion[1]), 18, 'node on the Pi is too old for the agent');
    ctx.note(`node: v${nodeVersion[1]}`);

    ctx.step('agent running');
    assert(await ctx.pi.agentActive(), 'padel-agent is not active — `systemctl status padel-agent`');
    ctx.note(`agent version: ${await ctx.pi.agentVersion()}`);

    ctx.step('spool directory writable');
    const spool = await ctx.pi.sh(
      `mkdir -p ${ctx.config.spoolDir} 2>/dev/null; test -w ${ctx.config.spoolDir} && echo ok`,
    );
    assert(spool.stdout.includes('ok'), `spool ${ctx.config.spoolDir} is not writable by the agent user`);
    const free = await ctx.pi.freeBytes();
    assertAtLeast(free, 2 * 1024 ** 3, 'less than 2 GiB free on the spool filesystem');
    ctx.note(`free disk: ${(free / 1024 ** 3).toFixed(1)} GiB`);

    ctx.step('clock is sane');
    // A Pi has no RTC. A wrong clock makes every duration assertion nonsense, and
    // in production it corrupts recording timestamps until NTP catches up.
    const piNow = Number(await ctx.pi.must('date +%s')) * 1000;
    const skew = Math.abs(piNow - Date.now());
    assert(skew < 120_000, `Pi clock is ${Math.round(skew / 1000)}s off — NTP has not synced`);

    ctx.step('court is online in the Worker');
    const court = await ctx.api.court(ctx.config.courtId);
    assert(court, `court ${ctx.config.courtId} is not assigned to this admin's venue`);
    assert(
      court.online,
      `court ${ctx.config.courtId} reads offline. The agent is running, so this is ` +
        `the control WebSocket failing to reach the Worker, or a DEVICE_TOKEN mismatch.`,
    );
    ctx.note(`worker sees agent: ${court.agentVersion ?? 'no version'}`);

    ctx.step('measuring what this hardware can actually encode');
    // The number that decides whether 1080p30 is honest on this board. A Pi 5 has
    // no hardware H.264 encoder, so this is a software encode and may not sustain
    // real time -- which shows up as short recordings, never as an error.
    const probeCmd =
      `cd /tmp && timeout 20 sh -c '${captureProbeCommand()}' >/tmp/e2e-probe.mp4 2>/tmp/e2e-probe.err; ` +
      `ffprobe -v error -select_streams v:0 -count_frames ` +
      `-show_entries stream=nb_read_frames -show_entries format=duration -of json /tmp/e2e-probe.mp4`;
    const probeOut = await ctx.pi.sh(probeCmd, 120_000);
    const parsed = /"duration":\s*"([\d.]+)"/.exec(probeOut.stdout);
    const framesMatch = /"nb_read_frames":\s*"(\d+)"/.exec(probeOut.stdout);
    if (parsed && framesMatch) {
      const duration = Number(parsed[1]);
      const frames = Number(framesMatch[1]);
      const fps = duration > 0 ? frames / duration : 0;
      const realtime = duration / 15; // 15s of requested capture
      ctx.note(`encoder: ${frames} frames, ${duration.toFixed(1)}s of video from 15s wall (${(realtime * 100).toFixed(0)}% real time, ${fps.toFixed(1)} fps)`);
      if (realtime < 0.9) {
        ctx.note(
          `WARNING: this board is not keeping up at the configured resolution. ` +
            `Recordings will come back short. Consider 1280x720 in CAPTURE_CMD.`,
        );
      }
    } else {
      ctx.note(`encoder probe inconclusive: ${probeOut.stdout.slice(0, 200)}`);
    }
    await ctx.pi.sh('rm -f /tmp/e2e-probe.mp4 /tmp/e2e-probe.err');
  },
};

/**
 * A short standalone capture using the same pipeline shape as CAPTURE_CMD, to
 * measure the encoder without involving the agent or the network.
 */
function captureProbeCommand(): string {
  return (
    'rpicam-vid -t 15000 --nopreview --width 1920 --height 1080 --framerate 30 --codec yuv420 -o - | ' +
    'ffmpeg -loglevel error -f rawvideo -pix_fmt yuv420p -s 1920x1080 -r 30 -i - ' +
    '-c:v libx264 -preset veryfast -tune zerolatency ' +
    '-movflags frag_keyframe+empty_moov+default_base_moof -f mp4 -'
  );
}
