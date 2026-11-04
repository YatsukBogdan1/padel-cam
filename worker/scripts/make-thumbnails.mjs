#!/usr/bin/env node
/**
 * Generate first-frame thumbnails for stored recordings.
 *
 * Runs on your machine, against the deployed Worker, and touches nothing in the
 * recording path: thumbnails exist so you can tell footage apart before
 * deleting it, and that is not worth a single extra failure mode on a Pi
 * mid-match.
 *
 *   node worker/scripts/make-thumbnails.mjs                 # only what's missing
 *   node worker/scripts/make-thumbnails.mjs --force         # redo them all
 *   node worker/scripts/make-thumbnails.mjs --base http://127.0.0.1:8787
 *
 * Requires ffmpeg on PATH and a super-admin login (prompted, never echoed).
 * Set PADEL_EMAIL and PADEL_PASSWORD to run it unattended.
 *
 * Only the first few MiB of each video is fetched, via a Range request -- the
 * capture is a fragmented MP4, so the opening fragment already contains a
 * keyframe. A 4 GB match costs the same as a 40 MB one.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

const DEFAULT_BASE = 'https://padel-worker.YOUR-SUBDOMAIN.workers.dev';
/** Enough to contain the opening keyframe at 1080p; ffmpeg stops well before this. */
const HEAD_BYTES = 4 * 1024 * 1024;
const WIDTH = 480;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const BASE = (arg('base', DEFAULT_BASE) ?? DEFAULT_BASE).replace(/\/$/, '');
const FORCE = process.argv.includes('--force');

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, encoding, done) {
        if (!muted) process.stdout.write(chunk, encoding);
        done();
      },
    });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = hidden;
  });
}

/** Pull the session cookie out of Set-Cookie and reuse it for every later call. */
async function login() {
  // Env vars let this run unattended (and make it testable); otherwise prompt.
  const email = process.env.PADEL_EMAIL || (await ask('Super-admin email: '));
  const password =
    process.env.PADEL_PASSWORD || (await ask(`Password for ${email}: `, true));

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    console.error(`!! Login failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
    process.exit(1);
  }
  const me = await res.json();
  if (!me.isSuperadmin) {
    console.error('!! That account is not a super-admin. Run grant-super.mjs first.');
    process.exit(1);
  }
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie) {
    console.error('!! No session cookie returned.');
    process.exit(1);
  }
  return cookie;
}

/** Decode the first frame of a partial fragmented MP4 into a JPEG. */
function firstFrameJpeg(mp4Head) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-vf', `scale=${WIDTH}:-2`,
      '-q:v', '5',
      '-f', 'image2',
      '-c:v', 'mjpeg',
      'pipe:1',
    ]);

    const chunks = [];
    const errors = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => errors.push(d));
    // ffmpeg exits as soon as it has its one frame, so the tail of the write
    // lands on a closed pipe. That is success, not an error.
    ff.stdin.on('error', () => {});
    ff.on('error', (e) => resolve({ error: `ffmpeg not runnable: ${e.message}` }));
    ff.on('close', () => {
      const jpeg = Buffer.concat(chunks);
      resolve(
        jpeg.length > 0
          ? { jpeg }
          : { error: Buffer.concat(errors).toString().trim().split('\n').at(-1) || 'no frame decoded' },
      );
    });

    ff.stdin.end(mp4Head);
  });
}

const cookie = await login();

const overview = await fetch(`${BASE}/api/super/overview`, { headers: { cookie } });
if (!overview.ok) {
  console.error(`!! Could not read the fleet overview (HTTP ${overview.status}).`);
  process.exit(1);
}
const { recordings } = await overview.json();

// Only finished recordings have an object to read a frame from: `failed` rows
// captured nothing and `expired` rows have had their video deleted.
const targets = recordings.filter(
  (r) => r.status === 'ready' && (FORCE || !r.thumbnail_key),
);

console.log(
  `\n==> ${targets.length} recording(s) need a thumbnail ` +
    `(${recordings.length} total, ${FORCE ? 'forced' : 'skipping ones that have one'})\n`,
);

let made = 0;
let skipped = 0;
for (const rec of targets) {
  const label = `${rec.id.slice(0, 8)} ${rec.court_id}`;
  const res = await fetch(`${BASE}/api/recordings/${rec.id}/download`, {
    headers: { cookie, range: `bytes=0-${HEAD_BYTES - 1}` },
  });
  if (!res.ok && res.status !== 206) {
    console.log(`  ${label}: skipped (video HTTP ${res.status})`);
    skipped++;
    continue;
  }

  const head = Buffer.from(await res.arrayBuffer());
  const { jpeg, error } = await firstFrameJpeg(head);
  if (!jpeg) {
    console.log(`  ${label}: skipped (${error})`);
    skipped++;
    continue;
  }

  const put = await fetch(`${BASE}/api/super/recordings/${rec.id}/thumbnail`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'image/jpeg' },
    body: jpeg,
  });
  if (!put.ok) {
    console.log(`  ${label}: upload failed (HTTP ${put.status})`);
    skipped++;
    continue;
  }
  console.log(
    `  ${label}: ok (${(head.length / 1048576).toFixed(1)}MiB read → ${(jpeg.length / 1024).toFixed(0)}KB jpeg)`,
  );
  made++;
}

console.log(`\n==> ${made} thumbnail(s) created, ${skipped} skipped.`);
