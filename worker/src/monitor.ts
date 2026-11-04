// The checks that nobody can push.
//
// Failures announce themselves -- a capture that dies calls /abort, and that
// path can email directly. Absences cannot: a court that stopped heartbeating
// sends nothing, by definition, and a Pi whose disk is filling has no reason to
// think anything is wrong yet. Those only surface by looking, which is why this
// runs on a short cron rather than waiting for the nightly sweep.
//
// The digest at the bottom is the dead man's switch. Without it, a notifier that
// is quietly broken looks exactly like a fleet where nothing is wrong.

import { listAllCourts, listActiveRecordings } from './db';
import { notify, clearAlert } from './notify';
import { isOnline } from './types';
import type { CourtHealth, Court, Env, Recording } from './types';

/**
 * Grace before a camera that vanished mid-recording is treated as interrupted,
 * rather than as a WiFi blip it will recover from on its own.
 */
const INTERRUPTED_GRACE_MS = 5 * 60_000;
/** Spool level at which the Pi is in real danger of sealing a match early. */
const DISK_WARN_FRACTION = 0.8;
/** Unsent backlog that means uploads are not keeping up at all. */
const BACKLOG_WARN_BYTES = 2 * 1024 * 1024 * 1024;

export async function runHealthChecks(env: Env): Promise<void> {
  const courts = await listAllCourts(env);
  // Fetched once rather than per court: this runs every five minutes.
  const active = await listActiveRecordings(env);
  const now = Date.now();

  for (const court of courts) {
    // Unassigned cameras are benches and spares; nobody is waiting on them.
    if (!court.venue_id) continue;
    await checkInterruptedRecording(env, court, active, now);
    // health_json is the LAST snapshot a camera sent, and it is never cleared. A
    // court that is switched off keeps its final reading forever, so checking it
    // re-sent the same throttling email every cooldown for days after the Pi was
    // unplugged. Only a live camera's telemetry describes the present.
    if (isOnline(court, now)) await checkHealth(env, court);
  }

  await checkDeviceToken(env, courts);
}

/**
 * A camera that disappeared **while it was recording**.
 *
 * Being offline is deliberately NOT an alert on its own. A club turns cameras
 * off, courts close overnight, power gets cut on purpose -- paging a human for a
 * dark court at 23:00 is exactly the noise that gets an alert feed muted, and a
 * muted feed is worse than none. An idle offline court is covered where it
 * belongs: the daily digest lists it, and an operator who tries to start a
 * recording gets an immediate error in the browser.
 *
 * A camera vanishing mid-match is a different event entirely. Someone is on
 * court, a booking is being recorded, and the footage is now at risk -- that is
 * worth waking someone for, and it is rare enough to stay meaningful.
 */
async function checkInterruptedRecording(
  env: Env,
  court: Court,
  active: Recording[],
  now: number,
): Promise<void> {
  const key = `recording-interrupted:${court.id}`;
  if (isOnline(court, now)) {
    // Back up: forget the cooldown, so the next interruption emails immediately
    // rather than being swallowed by a quiet window left over from this one.
    await clearAlert(env, key);
    return;
  }

  const silentMs = court.last_seen ? now - court.last_seen : Number.POSITIVE_INFINITY;
  // Short blips recover by themselves; the spool means they cost nothing.
  if (silentMs < INTERRUPTED_GRACE_MS) return;

  // Only `recording` counts. A row in `uploading` means capture already finished
  // and the spool is draining -- the camera can be away for hours and still
  // deliver, which is the whole point of the buffer. If it never does, the stale
  // sweep says so when it gives up.
  const interrupted = active.filter((r) => r.court_id === court.id && r.status === 'recording');
  if (interrupted.length === 0) return;

  await notify(env, {
    key,
    severity: 'critical',
    subject: `Recording interrupted — ${court.id} went offline mid-match`,
    body:
      `${court.name ?? court.id} (venue ${court.venue_id}) stopped responding ` +
      `${Math.round(silentMs / 60_000)} minutes ago, with ${interrupted.length} ` +
      `recording(s) still in progress:\n\n` +
      interrupted
        .map(
          (r) =>
            `  ${r.id} — started ${new Date(r.started_at).toISOString()}, ` +
            `${Math.round((now - r.started_at) / 60_000)} min in, ${r.bytes} bytes uploaded`,
        )
        .join('\n') +
      `\n\nWhatever was captured before it went is buffered on the Pi and will ` +
      `upload when it returns. If it does not come back, that footage is lost.\n\n` +
      `  ssh pi@${court.id}\n` +
      `  journalctl -u padel-agent -n 50`,
  });
}

async function checkHealth(env: Env, court: Court): Promise<void> {
  if (!court.health_json) return;
  let health: CourtHealth;
  try {
    health = JSON.parse(court.health_json) as CourtHealth;
  } catch {
    return;
  }

  if ((health.diskBudgetUsed ?? 0) >= DISK_WARN_FRACTION) {
    await notify(env, {
      key: `disk:${court.id}`,
      severity: 'warning',
      subject: `Court ${court.id} disk buffer is filling`,
      body:
        `The spool is at ${Math.round((health.diskBudgetUsed ?? 0) * 100)}% of its budget ` +
        `with ${fmtBytes(health.pendingBytes)} unsent.\n\n` +
        `At 95% the recording is sealed early -- the footage stays valid but stops ` +
        `short. This usually means the uplink has been down for a long time.`,
    });
  }

  if ((health.pendingBytes ?? 0) > BACKLOG_WARN_BYTES) {
    await notify(env, {
      key: `backlog:${court.id}`,
      severity: 'warning',
      subject: `Court ${court.id} has ${fmtBytes(health.pendingBytes)} waiting to upload`,
      body: `${health.pendingParts ?? 0} parts are spooled and not yet in R2. Uploads are not keeping up with capture.`,
    });
  }

  // `vcgencmd get_throttled` mixes two kinds of bit: 0x1-0x8 are what is happening
  // NOW (under-voltage, freq capped, throttled, soft temp limit), 0x10000-0x80000
  // are the same conditions latched "at some point since boot". Alerting on the
  // raw value meant one hot minute paged every cooldown until the next reboot --
  // 0xe0000 at 50.5°C is a Pi that is fine. Only the current bits are a problem.
  const throttledNow = (parseInt(health.throttled ?? '0', 16) || 0) & 0xf;
  if (throttledNow) {
    // A Pi 5 software-encoding 1080p30 in a hot court throttles, and the symptom
    // is footage that comes back short rather than anything that looks like an error.
    await notify(env, {
      key: `throttled:${court.id}`,
      severity: 'warning',
      subject: `Court ${court.id} is throttling (${health.throttled})`,
      body:
        `SoC temperature ${health.tempC ?? '?'}°C, throttled flags ${health.throttled}.\n\n` +
        `Throttling drops frames without failing, so recordings will be short rather ` +
        `than missing. Check ventilation and the power supply.`,
    });
  }
}

/**
 * The device surface is unauthenticated whenever DEVICE_TOKEN is unset, which is
 * the intended local-dev mode and a serious hole in production: anyone could
 * attach as an existing court and evict the real camera.
 */
async function checkDeviceToken(env: Env, courts: Court[]): Promise<void> {
  if (env.DEVICE_TOKEN) return;
  if (!courts.some((c) => c.venue_id)) return; // nothing live yet; dev is fine

  await notify(env, {
    key: 'device-token-missing',
    severity: 'critical',
    subject: 'DEVICE_TOKEN is not set and cameras are live',
    body:
      `The device surface (/agent, part upload, complete, abort) is unauthenticated.\n\n` +
      `Anyone can attach a fake camera as an existing court and evict the real one.\n\n` +
      `Fix, in this order or the Pis lock themselves out:\n` +
      `  1. openssl rand -base64 32\n` +
      `  2. put it in .fleet.env AND each Pi's padel-agent.env, restart each agent\n` +
      `  3. cd worker && npx wrangler secret put DEVICE_TOKEN`,
    cooldownMs: 12 * 60 * 60_000,
  });
}

/**
 * A daily "everything is fine" so silence is never ambiguous. If this stops
 * arriving, the notifier itself is broken -- which is otherwise indistinguishable
 * from a fleet with nothing wrong.
 */
export async function runDigest(env: Env): Promise<void> {
  const courts = await listAllCourts(env);
  const assigned = courts.filter((c) => c.venue_id);
  const online = assigned.filter((c) => isOnline(c));
  const active = await listActiveRecordings(env);

  const lines = assigned.map((c) => {
    const health = parseHealth(c.health_json);
    const bits = [
      isOnline(c) ? 'online' : 'OFFLINE',
      c.agent_version ?? 'no version',
      health?.pendingParts ? `${health.pendingParts} parts pending` : null,
      health?.tempC ? `${health.tempC}°C` : null,
    ].filter(Boolean);
    return `  ${c.id}: ${bits.join(', ')}`;
  });

  const dark = assigned.filter((c) => !isOnline(c));
  await notify(env, {
    key: 'daily-digest',
    severity: 'info',
    subject: `Fleet: ${online.length}/${assigned.length} courts online`,
    body:
      `${online.length} of ${assigned.length} assigned courts are online.\n` +
      `${active.length} recording(s) in flight.\n\n` +
      `${lines.join('\n')}\n\n` +
      (dark.length > 0
        ? `${dark.length} court(s) are dark. That is normal if the club powers them ` +
          `down -- it is only reported here, not paged, because a court being off is ` +
          `usually a decision rather than a fault. A camera that vanishes MID-MATCH ` +
          `is paged immediately.\n\n`
        : '') +
      `This digest is a dead man's switch: if it stops arriving, the alerting is broken.`,
    // Just under a day, so a slightly late cron never skips one entirely.
    cooldownMs: 23 * 60 * 60_000,
  });
}

function parseHealth(json: string | null): CourtHealth | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as CourtHealth;
  } catch {
    return null;
  }
}

function fmtBytes(n: number | undefined): string {
  if (!n) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
