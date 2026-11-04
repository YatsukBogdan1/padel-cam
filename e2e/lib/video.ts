// Proving the file is actually a match, not just bytes.
//
// Byte counts are the weakest possible check: a capture that stalled forty
// minutes into a sixty-minute match still produces a large, valid-looking,
// perfectly downloadable object. Only decoding it says how much of the game is
// really there, which is why every recording scenario ends here.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Probe {
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  frames: number;
  avgFps: number;
}

/** Read a downloaded recording with ffprobe. Throws if it will not decode. */
export async function probe(path: string): Promise<Probe> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=width,height,codec_name,nb_read_frames,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    path,
  ], { maxBuffer: 8 * 1024 * 1024, timeout: 300_000 });

  const data = JSON.parse(stdout) as {
    streams?: {
      width?: number;
      height?: number;
      codec_name?: string;
      nb_read_frames?: string;
      duration?: string;
    }[];
    format?: { duration?: string };
  };

  const stream = data.streams?.[0];
  if (!stream) throw new Error(`no video stream in ${path}`);

  const frames = Number(stream.nb_read_frames ?? 0);
  // A fragmented MP4 written by a killed encoder often has no duration in the
  // container, so fall back to counting frames -- which is the honest number
  // anyway, since it is what a viewer would actually see.
  const durationSec =
    Number(data.format?.duration ?? 0) || Number(stream.duration ?? 0) || 0;

  return {
    durationSec,
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    codec: stream.codec_name ?? 'unknown',
    frames,
    avgFps: durationSec > 0 ? frames / durationSec : 0,
  };
}

/**
 * Pull a frame out of the video as a JPEG, so a human can confirm the camera was
 * pointed at a padel court and not at a lens cap. No automated check catches
 * that, and it is the failure that wastes a whole booking.
 */
export async function extractFrame(
  videoPath: string,
  atSecond: number,
  outPath: string,
): Promise<boolean> {
  try {
    await exec(
      'ffmpeg',
      ['-y', '-ss', String(atSecond), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outPath],
      { timeout: 120_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * How much of the wall-clock recording window actually made it into the file.
 *
 * Below 1.0 means frames were dropped -- on a Pi 5 the usual cause is that
 * 1080p30 is a software encode (no hardware H.264 on that board) and the CPU
 * cannot sustain it. That degrades silently, so it has to be measured.
 */
export function coverage(probeResult: Probe, wallSeconds: number): number {
  if (wallSeconds <= 0) return 0;
  return probeResult.durationSec / wallSeconds;
}
