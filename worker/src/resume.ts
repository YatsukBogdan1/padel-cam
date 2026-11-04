// What a camera should do with footage it comes back holding.
//
// A Pi that loses power mid-match reboots with the captured bytes still in its
// spool and no idea whether the match is still running. It cannot know: the
// operator may have pressed stop while it was down, the booking may have ended,
// the court may have been unassigned. So the Pi reports what it has and this
// decides -- local state is data, the server is the decision.
//
// Getting that split wrong in either direction is expensive. Resume too eagerly
// and a camera records an empty court for hours after a match ended; refuse to
// resume and a power blip costs the second half of someone's game.

import { getCourt, getMatch, getRecording, listSessionSegments, updateRecording } from './db';
import { openSegment } from './handlers';
import type { Env, Recording } from './types';

/** Longer than any real match: past this, a session cannot still be running. */
const MAX_SESSION_MS = 5 * 60 * 60_000;

/** One spooled segment, as the agent reports it on connect. */
export interface ResumeReport {
  localId: string;
  recordingId: string | null;
  sessionId: string | null;
  segment: number;
  sealed: boolean;
  pendingParts: number;
  capturing: boolean;
}

export interface ResumeDecision {
  localId: string;
  /**
   * `drain` deliver what you have; `discard` throw it away; `register` means the
   * segment was captured with no network and has just been given a row here;
   * `stop-capture` means the match ended while this camera was unreachable.
   */
  action: 'drain' | 'discard' | 'register' | 'stop-capture';
  /** Set by `register`: the row and multipart upload now waiting for these bytes. */
  recordingId?: string;
  /** When set, resume capture as the next segment of this session. */
  continueSession?: string | null;
  nextSegment?: number;
}

export async function resumePlanFor(
  env: Env,
  courtId: string,
  reports: ResumeReport[],
  now = Date.now(),
): Promise<ResumeDecision[]> {
  const plan: ResumeDecision[] = [];
  const court = await getCourt(env, courtId);

  // Whether the match is still live is a property of the session, not of any one
  // segment, so decide it once.
  const sessionId = reports.find((r) => r.sessionId)?.sessionId ?? null;
  const siblings = sessionId ? await listSessionSegments(env, sessionId) : [];
  // A match carries its own end. Checked here as well as by auto-stop, because a
  // Pi can come back in the minutes between the end time and the alarm or cron
  // getting round to stamping the stop -- and would otherwise open a fresh
  // segment of the next group's booking.
  const match = sessionId ? await getMatch(env, sessionId) : null;
  const resumable =
    sessionId !== null &&
    court?.venue_id != null &&
    !reports.some((r) => r.capturing) &&
    !siblings.some((s) => s.stop_requested_at !== null) &&
    (match === null || match.ends_at > now) &&
    sessionAge(siblings, now) < MAX_SESSION_MS;

  for (const report of reports) {
    plan.push(await decide(env, courtId, report, sessionId));
  }

  if (resumable && sessionId) {
    // Attach the continuation to the newest segment, so the agent acts on it once
    // rather than opening a capture per recovered segment.
    const last = plan[plan.length - 1];
    if (last) {
      last.continueSession = sessionId;
      last.nextSegment = Math.max(0, ...siblings.map((s) => s.segment), ...reports.map((r) => r.segment)) + 1;
    }
  }

  return plan;
}

async function decide(
  env: Env,
  courtId: string,
  report: ResumeReport,
  sessionId: string | null,
): Promise<ResumeDecision> {
  // Captured with no network at all: there is no row and no multipart upload
  // waiting for these bytes, so make one now and hand back its id.
  if (!report.recordingId) {
    if (!sessionId || report.pendingParts === 0) {
      return { localId: report.localId, action: 'discard' };
    }
    const rec = await openSegment(env, courtId, sessionId, report.segment);
    return { localId: report.localId, action: 'register', recordingId: rec.id };
  }

  const row = await getRecording(env, report.recordingId);
  if (!row) return { localId: report.localId, action: 'discard' };

  // The sweep, a fleet-page cleanup, or a previous abort already ended this one.
  // Its multipart upload is gone, so the bytes have nowhere to land.
  if (row.status === 'failed' || row.status === 'expired' || row.status === 'ready') {
    return { localId: report.localId, action: 'discard' };
  }

  // Still rolling. If the operator ended the match while this camera was
  // unreachable, the stop command went nowhere and NOTHING else would ever tell
  // it -- so before the spool existed the camera just kept recording, and now it
  // would also keep filling the disk and R2 with an empty court.
  if (report.capturing) {
    if (row.stop_requested_at !== null || row.status !== 'recording') {
      return { localId: report.localId, action: 'stop-capture' };
    }
    return { localId: report.localId, action: 'drain' };
  }

  // A sealed segment is, by definition, no longer recording -- its capture died
  // with the power. The row still says `recording` because the agent never got
  // to send a status patch, and leaving it there blocks the very next step: the
  // session would look like it already had a live segment, and the camera could
  // not open the one it is about to record.
  if (report.sealed && row.status === 'recording') {
    await updateRecording(env, row.id, { status: 'uploading', stopped_at: Date.now() });
  }

  return { localId: report.localId, action: 'drain' };
}

function sessionAge(siblings: Recording[], now: number): number {
  if (siblings.length === 0) return 0;
  const earliest = Math.min(...siblings.map((s) => s.started_at));
  return now - earliest;
}
