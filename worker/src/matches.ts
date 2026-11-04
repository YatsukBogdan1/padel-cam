/**
 * A match: one recording session with an end time and a private link.
 *
 * Starting and stopping live here rather than in the HTTP handlers because four
 * callers now do it -- the operator's dashboard, a player at the court, the
 * court's auto-stop alarm, and the cron backstop -- and the rules (open the
 * upload before the camera goes, roll back if it never answers, stamp the stop
 * before relaying it) were each learned from a row that hung when one path
 * skipped them.
 */
import { track } from './analytics';
import { randomToken } from './auth';
import {
  createMatch,
  deleteMatch,
  getLiveRecordingOnCourt,
  listOverdueMatches,
  listSessionSegments,
} from './db';
import { abortRecording, commandCourt, openSegment, stopLiveRecording } from './handlers';
import type { Relay } from './handlers';
import type { Env, Match, Recording, Venue } from './types';

/**
 * The longest a match may be booked for. Also what staff get when they start
 * without choosing an end -- they stop it by hand, and this is the backstop if
 * they forget. Stays well under the stale sweep's 5 h `recording` threshold, so
 * auto-stop always gets there first.
 */
export const MAX_MATCH_MS = 3 * 60 * 60_000;

/** An end time this close is a mis-tap, not a match. */
const MIN_MATCH_MS = 5 * 60_000;

/** The shortest and longest end times offered on the court page. */
const OFFER_MIN_MS = 15 * 60_000;
const OFFER_MAX_MS = 2.5 * 60 * 60_000;

export type StartResult =
  | { ok: true; match: Match; recording: Recording }
  | { ok: false; status: 400 | 409; error: string; recordingId?: string };

/**
 * Open a match: the R2 upload first, then the match row, then the camera. If
 * the camera never acknowledges, the upload is aborted and the row marked
 * failed -- the same rollback the operator's start always had.
 */
export async function startMatch(
  env: Env,
  courtId: string,
  bookedUntil: number,
  startedBy: Match['started_by'],
): Promise<StartResult> {
  const now = Date.now();
  if (!Number.isFinite(bookedUntil) || bookedUntil < now + MIN_MATCH_MS) {
    return { ok: false, status: 400, error: 'End time must be at least 5 minutes away' };
  }
  if (bookedUntil > now + MAX_MATCH_MS) {
    return { ok: false, status: 400, error: 'A match can be booked for at most 3 hours' };
  }
  // The camera refuses a second start anyway, but that refusal costs a failed
  // row and a critical alert. A busy court is not a fault.
  const live = await getLiveRecordingOnCourt(env, courtId);
  if (live) return { ok: false, status: 409, error: 'This court is already recording' };

  // A match is a session. Segment 1 starts here; a power cut mid-match ends this
  // segment and the returning agent opens the next one under the same session.
  const sessionId = crypto.randomUUID();
  const recording = await openSegment(env, courtId, sessionId, 1);
  const match: Match = {
    session_id: sessionId,
    court_id: courtId,
    token: randomToken(16),
    booked_until: bookedUntil,
    ends_at: bookedUntil,
    started_by: startedBy,
    created_at: now,
  };
  await createMatch(env, match);

  // Tell the camera to start and wait for it to confirm. If nothing is
  // connected, or the socket is half-open and nobody answers, roll back cleanly
  // rather than showing a recording light for a camera that was never reached.
  const relay = await commandCourt(env, courtId, {
    type: 'start',
    recordingId: recording.id,
    sessionId,
    segment: 1,
  });
  if (!relay.ok) {
    await abortRecording(env, recording, relay.detail || 'camera did not acknowledge start');
    // The match row goes: it would be a link to footage that never existed. The
    // failed recording stays, so the operator can see why.
    await deleteMatch(env, sessionId);
    return {
      ok: false,
      status: 409,
      error: `Camera for court "${courtId}" did not respond: ${relay.detail}`,
      recordingId: recording.id,
    };
  }

  await scheduleAutoStop(env, courtId, match.ends_at);
  return { ok: true, match, recording };
}

/**
 * End a match: stop whichever segment is capturing, and record the intent on
 * the rest. A segment that is still uploading after a power cut gets the stamp
 * too -- that is what tells a Pi returning later not to open another segment.
 */
export async function stopMatch(env: Env, sessionId: string, relay?: Relay): Promise<void> {
  const segments = await listSessionSegments(env, sessionId);
  for (const rec of segments) {
    if (rec.stop_requested_at !== null) continue;
    if (rec.status === 'recording' || rec.status === 'uploading') {
      await stopLiveRecording(env, rec, relay);
    }
  }
}

/**
 * Stop every match past its end time. Called by the court's alarm, and fleet-wide
 * by the five-minute cron in case an alarm was lost: a camera recording an empty
 * court all night fills the Pi's disk and the bucket.
 */
export async function endOverdueMatches(
  env: Env,
  courtId?: string,
  relay?: Relay,
): Promise<number> {
  const overdue = await listOverdueMatches(env, Date.now(), courtId);
  for (const match of overdue) {
    console.log(`[auto-stop] ${match.court_id} session ${match.session_id}`);
    await track(env, {
      court_id: match.court_id,
      step: 'stopped',
      detail: 'auto',
      session_id: match.session_id,
    });
    await stopMatch(env, match.session_id, relay);
  }
  return overdue.length;
}

/** Ask the court's Durable Object to wake at `at` and end whatever is overdue. */
async function scheduleAutoStop(env: Env, courtId: string, at: number): Promise<void> {
  const stub = env.COURT_CAMERA.get(env.COURT_CAMERA.idFromName(courtId));
  await stub.fetch('https://do/alarm', {
    method: 'POST',
    body: JSON.stringify({ courtId, at }),
  });
}

// ---- the booking grid -----------------------------------------------------------

export interface EndOption {
  at: number;
  /** "20:30", in the venue's local time. */
  label: string;
}

/**
 * End times to offer, on the venue's slot grid. A group that starts at 19:10
 * for a 19:00-20:30 booking picks 20:30 and stops there, instead of recording
 * ten minutes of the next group, who never agreed to be filmed.
 */
export function endTimeOptions(
  venue: Pick<Venue, 'timezone' | 'slot_minutes'>,
  now = Date.now(),
): EndOption[] {
  const slotMs = venue.slot_minutes * 60_000;
  // Local minute-of-hour decides alignment. Working from it rather than from a
  // UTC offset keeps half-hour zones correct for free.
  const { minute } = localTime(now, venue.timezone);
  const intoSlot = ((minute % venue.slot_minutes) * 60_000) + (now % 60_000);
  let at = now - intoSlot + slotMs;

  const options: EndOption[] = [];
  for (; at <= now + OFFER_MAX_MS; at += slotMs) {
    if (at - now < OFFER_MIN_MS) continue;
    options.push({ at, label: formatLocalTime(at, venue.timezone) });
  }
  return options;
}

export function formatLocalTime(ms: number, timezone: string): string {
  const { hour, minute } = localTime(ms, timezone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function localTime(ms: number, timezone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: get('hour'), minute: get('minute') };
}

/** Whether `timezone` is an IANA zone this runtime knows. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
