// Where the suite points and what it is allowed to do.
//
// Everything comes from e2e/.env (gitignored), because the two things this needs
// -- an admin password and the device token -- must never be in the repo.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(E2E_ROOT);

export interface Config {
  /** Worker under test. A deployed URL, or http://127.0.0.1:8787 for local dev. */
  backend: string;
  /** SSH target for the camera, e.g. pi@court-test-1. */
  pi: string;
  /** The court id that Pi is configured with. */
  courtId: string;
  adminEmail: string;
  adminPassword: string;
  /** Must match the Worker's DEVICE_TOKEN secret, when one is set. */
  deviceToken: string;
  /** Where the agent spools on the Pi. */
  spoolDir: string;
  /** Seconds of video each recording scenario captures. */
  recordSeconds: number;
  /**
   * Lowest acceptable ratio of captured duration to wall-clock duration.
   *
   * Not 1.0, and the gap is the interesting part: a Pi 5 has no hardware H.264
   * encoder, so 1080p30 is a software encode that may not sustain real time.
   * Frames are then dropped rather than the recording failing -- which is the
   * exact failure mode that is invisible until a customer asks for their match.
   * `preflight` measures the real number for this hardware.
   */
  minDurationRatio: number;
  /** Keep recordings created by the suite instead of purging them. */
  keepRecordings: boolean;
  /**
   * A synthetic CAPTURE_CMD for scenarios that test the PIPELINE rather than the
   * camera.
   *
   * H.264 bitrate is content-dependent, so anything sized in bytes -- the disk
   * budget above all -- inherits the scene's compressibility. The home camera
   * pointed at a dim room produced ~90 KiB/s, roughly a hundredth of what a lit
   * court gives, so a byte target that filled in seconds one day took half an
   * hour the next. Neither duration says anything about whether the budget logic
   * works.
   *
   * lavfi generates frames as fast as the encoder consumes them, with the rate
   * forced rather than negotiated, so this delivers a known ~15 MiB/s that does
   * not depend on what the lens is looking at -- and still produces a real,
   * decodable MP4, so the "truncated file must still play" assertion stays honest.
   */
  mockCaptureCmd: string;
}

const DEFAULTS: Record<string, string> = {
  SPOOL_DIR: '/var/lib/padel-agent/spool',
  RECORD_SECONDS: '45',
  MOCK_CAPTURE_CMD:
    'ffmpeg -loglevel error -f lavfi -i testsrc2=size=640x480:rate=30 ' +
    '-c:v libx264 -preset ultrafast -b:v 20M -minrate 20M -maxrate 20M -bufsize 40M ' +
    '-movflags frag_keyframe+empty_moov+default_base_moof -f mp4 -',
  MIN_DURATION_RATIO: '0.8',
};

export function loadConfig(): Config {
  const envPath = join(E2E_ROOT, '.env');
  if (!existsSync(envPath)) {
    throw new Error(
      `Missing ${envPath}\n\n` +
        `Copy e2e/.env.example to e2e/.env and fill it in. It holds an admin\n` +
        `password and the device token, which is why it is gitignored.`,
    );
  }

  const env = { ...DEFAULTS, ...parseEnvFile(readFileSync(envPath, 'utf8')), ...pickFromProcess() };

  const need = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`${key} is not set in e2e/.env`);
    return value;
  };

  return {
    backend: need('BACKEND').replace(/\/$/, ''),
    pi: need('PI_HOST'),
    courtId: need('COURT_ID'),
    adminEmail: need('ADMIN_EMAIL'),
    adminPassword: need('ADMIN_PASSWORD'),
    deviceToken: env.DEVICE_TOKEN ?? '',
    spoolDir: need('SPOOL_DIR'),
    recordSeconds: Number(need('RECORD_SECONDS')),
    minDurationRatio: Number(need('MIN_DURATION_RATIO')),
    keepRecordings: process.env.KEEP_RECORDINGS === '1',
    mockCaptureCmd: need('MOCK_CAPTURE_CMD'),
  };
}

/** Process env wins, so one-off overrides need no file edit. */
function pickFromProcess(): Record<string, string> {
  const keys = [
    'BACKEND',
    'PI_HOST',
    'COURT_ID',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
    'DEVICE_TOKEN',
    'SPOOL_DIR',
    'RECORD_SECONDS',
    'MIN_DURATION_RATIO',
    'MOCK_CAPTURE_CMD',
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
