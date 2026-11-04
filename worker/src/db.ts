import { PRESENCE_TTL_MS, STATUS_TRANSITIONS } from './types';
import type {
  Admin,
  Court,
  Env,
  Match,
  Recording,
  RecordingEventKind,
  RecordingStatus,
  ShareLink,
  Venue,
} from './types';

// Columns the app is allowed to patch on a recording row.
const RECORDING_COLUMNS = [
  'status',
  'upload_id',
  'object_key',
  'bytes',
  'purchased',
  'stopped_at',
  'error',
  'thumbnail_key',
  'agent_claimed_at',
  'truncated',
  'warning',
  'stop_requested_at',
] as const;
type PatchableColumn = (typeof RECORDING_COLUMNS)[number];

/** An upload should drain within minutes of capture stopping. */
const UPLOAD_GRACE_MS = 30 * 60_000;
/** Longer than any real match, so the sweep never interrupts a live recording. */
const MAX_RECORDING_MS = 5 * 60 * 60_000;
/** Grace for a recording whose court has stopped heartbeating entirely. */
const ORPHAN_GRACE_MS = 10 * 60_000;
/**
 * How long a camera's claim on a recording holds off the sweep. The agent renews
 * it on every heartbeat while it still has unsent parts on disk, so this only has
 * to outlast a few missed beats -- not the outage itself.
 */
const CLAIM_TTL_MS = 5 * 60_000;
/**
 * The ceiling no claim may exceed. R2 auto-aborts an incomplete multipart upload
 * after 7 days regardless of what we believe, so a lease that outlived it would
 * be promising to deliver into an upload that no longer exists.
 */
const MAX_CLAIM_MS = 6 * 24 * 60 * 60_000;

/**
 * Invert STATUS_TRANSITIONS: for a target status, which statuses may precede it.
 * Used to express the guard as a WHERE clause so the check and the write are one
 * statement -- a read-then-write would race the agent's WebSocket status patch,
 * which arrives on a completely different connection.
 */
const STATUS_PREDECESSORS: Record<RecordingStatus, RecordingStatus[]> = (() => {
  const inverse = {} as Record<RecordingStatus, RecordingStatus[]>;
  for (const target of Object.keys(STATUS_TRANSITIONS) as RecordingStatus[]) {
    inverse[target] = [];
  }
  for (const [from, targets] of Object.entries(STATUS_TRANSITIONS)) {
    for (const target of targets) inverse[target].push(from as RecordingStatus);
  }
  return inverse;
})();

export async function createRecording(env: Env, rec: Recording): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO recordings
       (id, court_id, status, upload_id, object_key, bytes, purchased, started_at, stopped_at,
        created_at, session_id, segment, agent_claimed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      rec.id,
      rec.court_id,
      rec.status,
      rec.upload_id,
      rec.object_key,
      rec.bytes,
      rec.purchased,
      rec.started_at,
      rec.stopped_at,
      rec.created_at,
      rec.session_id,
      rec.segment,
      // Claimed from the moment it exists. A recording that starts and loses the
      // network a second later must not look abandoned to the sweep.
      rec.agent_claimed_at,
    )
    .run();
}

export function getRecording(env: Env, id: string): Promise<Recording | null> {
  return env.DB.prepare(`SELECT * FROM recordings WHERE id = ?`)
    .bind(id)
    .first<Recording>();
}

export async function listRecordings(env: Env, limit = 100): Promise<Recording[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM recordings ORDER BY started_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<Recording>();
  return results;
}

/**
 * Patch a subset of a recording's columns. Unknown keys are ignored.
 *
 * A patch that moves `status` is only applied when the row is currently in a
 * status that legally precedes the target. This is what stops a stop command
 * from resurrecting a recording whose capture already died: the row is
 * `failed`, `failed -> uploading` is not a legal edge, so the whole patch is a
 * no-op instead of stranding the row in `uploading` forever.
 *
 * Returns whether the row was actually written, so callers can tell a refused
 * transition from an applied one.
 */
export async function updateRecording(
  env: Env,
  id: string,
  patch: Partial<Pick<Recording, PatchableColumn>>,
): Promise<boolean> {
  const cols = RECORDING_COLUMNS.filter((c) => patch[c] !== undefined);
  if (cols.length === 0) return false;
  const setClause = cols.map((c) => `${c} = ?`).join(', ');
  const values = cols.map((c) => patch[c] as string | number | null);

  const target = patch.status as RecordingStatus | undefined;
  if (!target) {
    await env.DB.prepare(`UPDATE recordings SET ${setClause} WHERE id = ?`)
      .bind(...values, id)
      .run();
    return true;
  }

  const allowed = STATUS_PREDECESSORS[target] ?? [];
  if (allowed.length === 0) return false; // nothing may transition into it
  const placeholders = allowed.map(() => '?').join(', ');
  const res = await env.DB.prepare(
    `UPDATE recordings SET ${setClause}
      WHERE id = ? AND status IN (${placeholders})`,
  )
    .bind(...values, id, ...allowed)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Recordings that never reached a terminal state: still `recording` or
 * `uploading` well after they should have finished. Each one holds an
 * un-aborted R2 multipart upload that is billed and invisible in a bucket
 * listing, which is why these are swept rather than left alone.
 */
export async function findStaleRecordings(
  env: Env,
  now = Date.now(),
): Promise<Recording[]> {
  // Three separate clocks, because "stale" means something different per state:
  //
  //  - uploading: parts should drain in minutes once capture has stopped, so a
  //    long wait here means the agent died mid-upload.
  //  - recording: must outlast the longest real match, or the sweep would kill
  //    a session that is going perfectly well.
  //  - orphaned: the court stopped heartbeating, so no camera is coming back to
  //    finish this one -- collectable far sooner than either window above.
  //
  // All three are now subordinate to the camera's lease. A Pi buffering footage
  // through a network outage is indistinguishable from an abandoned recording by
  // any of these clocks -- same silent court, same stalled upload -- so without
  // the lease, adding an on-disk buffer would make things worse rather than
  // better: the camera would return with hours of video and deliver it into a
  // multipart upload this sweep had already aborted.
  const { results } = await env.DB.prepare(
    `SELECT r.* FROM recordings r
       LEFT JOIN courts c ON c.id = r.court_id
      WHERE r.status IN ('recording', 'uploading')
        AND (
              -- Past the ceiling, nothing can save it: R2 has dropped the upload.
              r.created_at < ?
           OR (
                (r.agent_claimed_at IS NULL OR r.agent_claimed_at < ?)
                AND (
                      (r.status = 'uploading' AND COALESCE(r.stopped_at, r.created_at) < ?)
                   OR (r.status = 'recording' AND r.created_at < ?)
                   OR (COALESCE(c.last_seen, 0) < ? AND r.created_at < ?)
                )
              )
        )
      ORDER BY r.created_at ASC`,
  )
    .bind(
      now - MAX_CLAIM_MS,
      now - CLAIM_TTL_MS,
      now - UPLOAD_GRACE_MS,
      now - MAX_RECORDING_MS,
      now - PRESENCE_TTL_MS,
      now - ORPHAN_GRACE_MS,
    )
    .all<Recording>();
  return results ?? [];
}

/**
 * Renew a camera's lease on the recordings it still holds bytes for. Called from
 * the heartbeat, so it costs one write per court per 30s and keeps the sweep off
 * anything a live camera is still working on.
 */
export async function renewClaims(
  env: Env,
  recordingIds: string[],
  now = Date.now(),
): Promise<void> {
  if (recordingIds.length === 0) return;
  const placeholders = recordingIds.map(() => '?').join(', ');
  await env.DB.prepare(
    `UPDATE recordings SET agent_claimed_at = ?
      WHERE id IN (${placeholders}) AND status IN ('recording', 'uploading')`,
  )
    .bind(now, ...recordingIds)
    .run();
}

/**
 * Add to a recording's byte count in one statement.
 *
 * `updateRecording` writes literals, which was a read-modify-write here: fine
 * while parts arrived strictly in order from a single in-memory queue, wrong now
 * that a spool can deliver them out of order after an outage.
 */
export async function addRecordingBytes(env: Env, id: string, delta: number): Promise<void> {
  await env.DB.prepare(`UPDATE recordings SET bytes = bytes + ? WHERE id = ?`)
    .bind(delta, id)
    .run();
}

/** Every segment of one match, oldest first. */
export async function listSessionSegments(
  env: Env,
  sessionId: string,
): Promise<Recording[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM recordings WHERE session_id = ? ORDER BY segment ASC`,
  )
    .bind(sessionId)
    .all<Recording>();
  return results ?? [];
}

/** Latest telemetry from a court's heartbeat. */
export async function setCourtHealth(
  env: Env,
  courtId: string,
  health: unknown,
): Promise<void> {
  await env.DB.prepare(`UPDATE courts SET health_json = ? WHERE id = ?`)
    .bind(JSON.stringify(health).slice(0, 2000), courtId)
    .run();
}

/**
 * Every recording in the fleet, newest first, with the court's venue attached.
 * Super-admin only -- this is deliberately not venue-scoped, because it backs
 * the surface used to delete footage that no venue can reach any more.
 */
export async function listAllRecordings(
  env: Env,
  limit = 200,
): Promise<(Recording & { venue_id: string | null })[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.*, c.venue_id
       FROM recordings r LEFT JOIN courts c ON c.id = r.court_id
      ORDER BY r.created_at DESC
      LIMIT ?`,
  )
    .bind(limit)
    .all<Recording & { venue_id: string | null }>();
  return results ?? [];
}

/** Every recording not yet in a terminal state, for the super-admin's cleanup view. */
export async function listActiveRecordings(env: Env): Promise<Recording[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM recordings
       WHERE status IN ('recording', 'uploading')
       ORDER BY created_at DESC`,
  ).all<Recording>();
  return results ?? [];
}

export async function deleteRecording(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM share_links WHERE recording_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM recordings WHERE id = ?`).bind(id),
  ]);
}

export async function listCourts(env: Env): Promise<Court[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM courts ORDER BY id`,
  ).all<Court>();
  return results;
}

/**
 * Mark a court online/offline, creating the row on first sight.
 *
 * `last_seen` is only advanced while the court is online. Writing it on
 * disconnect too would make a clean shutdown look more recent than a crash,
 * and `isOnline()` reads that timestamp as evidence of life.
 */
export async function setCourtPresence(
  env: Env,
  courtId: string,
  online: boolean,
  now: number,
): Promise<void> {
  if (!online) {
    await env.DB.prepare(`UPDATE courts SET online = 0 WHERE id = ?`)
      .bind(courtId)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO courts (id, name, online, last_seen, created_at)
     VALUES (?, NULL, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET online = 1, last_seen = excluded.last_seen`,
  )
    .bind(courtId, now, now)
    .run();
}

/**
 * Advance `last_seen` on a heartbeat. One D1 write per court per HEARTBEAT_MS
 * (~2.9k/day/court) -- cheap at fleet scale, and it buys presence that expires
 * on its own rather than needing an alarm or a sweep to notice a dead Pi.
 */
export async function touchCourt(
  env: Env,
  courtId: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE courts SET online = 1, last_seen = ? WHERE id = ?`,
  )
    .bind(now, courtId)
    .run();
}

/** Record the agent version a court reported on connect. */
export async function setCourtVersion(
  env: Env,
  courtId: string,
  version: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE courts SET agent_version = ? WHERE id = ?`)
    .bind(version, courtId)
    .run();
}

/** Recordings eligible for retention deletion: unpurchased, ready, older than cutoff. */
/**
 * Rows retention should clear out.
 *
 * `failed` is included as well as `ready`. A failed start deliberately leaves a
 * row behind so the operator can see why, and its multipart upload is already
 * aborted -- but nothing ever removed those, so a court that fails occasionally
 * slowly fills its recordings page with dead entries that outlive any usefulness.
 * They age out on the same clock as real footage.
 */
export async function findExpirableRecordings(
  env: Env,
  cutoff: number,
): Promise<Recording[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM recordings
       WHERE purchased = 0 AND status IN ('ready', 'failed') AND created_at < ?`,
  )
    .bind(cutoff)
    .all<Recording>();
  return results;
}

// ---- venues, admins, courts scoping -------------------------------------------

export function getAdminByEmail(env: Env, email: string): Promise<Admin | null> {
  return env.DB.prepare(`SELECT * FROM admins WHERE email = ?`)
    .bind(email.trim().toLowerCase())
    .first<Admin>();
}

export function getVenue(env: Env, id: string): Promise<Venue | null> {
  return env.DB.prepare(`SELECT * FROM venues WHERE id = ?`).bind(id).first<Venue>();
}

export async function listCourtsForVenue(env: Env, venueId: string): Promise<Court[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM courts WHERE venue_id = ? ORDER BY id`,
  )
    .bind(venueId)
    .all<Court>();
  return results ?? [];
}

/** Courts that have connected but belong to nobody yet, offered for claiming. */
export async function listUnassignedCourts(env: Env): Promise<Court[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM courts WHERE venue_id IS NULL ORDER BY last_seen DESC`,
  ).all<Court>();
  return results ?? [];
}

/**
 * Point a court at a venue, or at nobody when `venueId` is null.
 *
 * There is no `venue_id IS NULL` guard here and no venue-scoped caller: this is
 * reachable only from the super-admin surface. Self-service claiming was the
 * bug -- any club admin could adopt a Pi that had just been installed at
 * another club's site, because "unassigned" was the only condition checked.
 */
export async function setCourtVenue(
  env: Env,
  courtId: string,
  venueId: string | null,
): Promise<boolean> {
  const res = await env.DB.prepare(`UPDATE courts SET venue_id = ? WHERE id = ?`)
    .bind(venueId, courtId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function setCourtName(
  env: Env,
  courtId: string,
  name: string | null,
): Promise<void> {
  await env.DB.prepare(`UPDATE courts SET name = ? WHERE id = ?`)
    .bind(name, courtId)
    .run();
}

export async function setCourtFreeUntil(
  env: Env,
  courtId: string,
  freeUntil: number | null,
): Promise<void> {
  await env.DB.prepare(`UPDATE courts SET free_until = ? WHERE id = ?`)
    .bind(freeUntil, courtId)
    .run();
}

export async function setVenueSchedule(
  env: Env,
  venueId: string,
  timezone: string,
  slotMinutes: number,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE venues SET timezone = ?, slot_minutes = ? WHERE id = ?`,
  )
    .bind(timezone, slotMinutes, venueId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export function getCourtByQrToken(env: Env, token: string): Promise<Court | null> {
  return env.DB.prepare(`SELECT * FROM courts WHERE qr_token = ?`)
    .bind(token)
    .first<Court>();
}

export async function setCourtQrToken(
  env: Env,
  courtId: string,
  token: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE courts SET qr_token = ? WHERE id = ?`)
    .bind(token, courtId)
    .run();
}

// ---- matches -------------------------------------------------------------------

export async function createMatch(env: Env, match: Match): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO matches
       (session_id, court_id, token, booked_until, ends_at, started_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      match.session_id,
      match.court_id,
      match.token,
      match.booked_until,
      match.ends_at,
      match.started_by,
      match.created_at,
    )
    .run();
}

/** Only for rolling back a start the camera never acknowledged. */
export async function deleteMatch(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM matches WHERE session_id = ?`).bind(sessionId).run();
}

export function getMatch(env: Env, sessionId: string): Promise<Match | null> {
  return env.DB.prepare(`SELECT * FROM matches WHERE session_id = ?`)
    .bind(sessionId)
    .first<Match>();
}

export function getMatchByToken(env: Env, token: string): Promise<Match | null> {
  return env.DB.prepare(`SELECT * FROM matches WHERE token = ?`)
    .bind(token)
    .first<Match>();
}

/**
 * The recording currently capturing on a court, if any. One court is one camera,
 * so there is at most one -- this is what "the court is busy" means.
 */
export function getLiveRecordingOnCourt(
  env: Env,
  courtId: string,
): Promise<Recording | null> {
  return env.DB.prepare(
    `SELECT * FROM recordings WHERE court_id = ? AND status = 'recording'
      ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(courtId)
    .first<Recording>();
}

/**
 * Matches past their end time that still have a segment capturing and nobody
 * has asked to stop. What auto-stop acts on -- from the court's alarm, and from
 * the five-minute cron as a backstop.
 */
export async function listOverdueMatches(
  env: Env,
  now: number,
  courtId?: string,
): Promise<Match[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.* FROM matches m
      WHERE m.ends_at <= ?1
        AND (?2 IS NULL OR m.court_id = ?2)
        AND EXISTS (SELECT 1 FROM recordings r
                     WHERE r.session_id = m.session_id
                       AND r.status = 'recording'
                       AND r.stop_requested_at IS NULL)`,
  )
    .bind(now, courtId ?? null)
    .all<Match>();
  return results ?? [];
}

// ---- recording events ----------------------------------------------------------

export async function recordEvent(
  env: Env,
  rec: Pick<Recording, 'id' | 'court_id'>,
  kind: RecordingEventKind,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO recording_events (recording_id, court_id, kind, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(rec.id, rec.court_id, kind, Date.now())
    .run();
}

/** Per-court engagement since `since`, for the experiment readout. */
export interface CourtEngagement {
  court_id: string;
  /** Ready recordings started in the window -- the denominator. */
  recordings: number;
  /** Recordings that got at least one player download -- the number that matters. */
  downloaded_recordings: number;
  views: number;
  downloads: number;
  locked_views: number;
  admin_downloads: number;
  /** Matches players started themselves from the court's QR code. */
  player_matches: number;
  /** Of those, how many had their link sent on -- the rest may have lost it. */
  shared_matches: number;
}

export async function listCourtEngagement(
  env: Env,
  since: number,
): Promise<CourtEngagement[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id AS court_id,
            (SELECT COUNT(*) FROM recordings r
              WHERE r.court_id = c.id AND r.started_at >= ?1
                AND r.status IN ('ready', 'expired')) AS recordings,
            (SELECT COUNT(DISTINCT e.recording_id) FROM recording_events e
              WHERE e.court_id = c.id AND e.kind = 'download' AND e.created_at >= ?1)
              AS downloaded_recordings,
            (SELECT COUNT(*) FROM recording_events e
              WHERE e.court_id = c.id AND e.kind = 'view' AND e.created_at >= ?1) AS views,
            (SELECT COUNT(*) FROM recording_events e
              WHERE e.court_id = c.id AND e.kind = 'download' AND e.created_at >= ?1) AS downloads,
            (SELECT COUNT(*) FROM recording_events e
              WHERE e.court_id = c.id AND e.kind = 'locked_view' AND e.created_at >= ?1)
              AS locked_views,
            (SELECT COUNT(*) FROM recording_events e
              WHERE e.court_id = c.id AND e.kind = 'admin_download' AND e.created_at >= ?1)
              AS admin_downloads,
            (SELECT COUNT(*) FROM matches m
              WHERE m.court_id = c.id AND m.started_by = 'player' AND m.created_at >= ?1)
              AS player_matches,
            (SELECT COUNT(DISTINCT e.recording_id) FROM recording_events e
              WHERE e.court_id = c.id AND e.kind = 'share' AND e.created_at >= ?1)
              AS shared_matches
       FROM courts c
      ORDER BY c.id`,
  )
    .bind(since)
    .all<CourtEngagement>();
  return results ?? [];
}

/** Every court in the fleet, with its venue's display name. Super-admin only. */
export async function listAllCourts(
  env: Env,
): Promise<(Court & { venue_name: string | null })[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.*, v.name AS venue_name
       FROM courts c LEFT JOIN venues v ON v.id = c.venue_id
      ORDER BY c.venue_id IS NULL DESC, c.venue_id, c.id`,
  ).all<Court & { venue_name: string | null }>();
  return results ?? [];
}

export function getCourt(env: Env, courtId: string): Promise<Court | null> {
  return env.DB.prepare(`SELECT * FROM courts WHERE id = ?`)
    .bind(courtId)
    .first<Court>();
}

/**
 * Remove a court row entirely. Refuses while recordings still reference it --
 * orphaning those rows would strand their R2 objects outside every venue-scoped
 * query, which is the same class of invisible leak this cleanup exists to fix.
 */
export async function deleteCourt(
  env: Env,
  courtId: string,
): Promise<{ deleted: boolean; recordings: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM recordings WHERE court_id = ?`,
  )
    .bind(courtId)
    .first<{ n: number }>();
  const recordings = row?.n ?? 0;
  if (recordings > 0) return { deleted: false, recordings };

  const res = await env.DB.prepare(`DELETE FROM courts WHERE id = ?`)
    .bind(courtId)
    .run();
  return { deleted: (res.meta?.changes ?? 0) > 0, recordings: 0 };
}

export async function listVenues(env: Env): Promise<Venue[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM venues ORDER BY name`,
  ).all<Venue>();
  return results ?? [];
}

/** Timezone and slot length take their column defaults until set on /super. */
export async function createVenue(
  env: Env,
  venue: Pick<Venue, 'id' | 'name' | 'created_at'>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO venues (id, name, created_at) VALUES (?, ?, ?)`,
  )
    .bind(venue.id, venue.name, venue.created_at)
    .run();
}

export function getCourtInVenue(
  env: Env,
  courtId: string,
  venueId: string,
): Promise<Court | null> {
  return env.DB.prepare(`SELECT * FROM courts WHERE id = ? AND venue_id = ?`)
    .bind(courtId, venueId)
    .first<Court>();
}

export async function listRecordingsForVenue(
  env: Env,
  venueId: string,
  limit = 100,
): Promise<Recording[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.* FROM recordings r
       JOIN courts c ON c.id = r.court_id
      WHERE c.venue_id = ?
      ORDER BY r.started_at DESC
      LIMIT ?`,
  )
    .bind(venueId, limit)
    .all<Recording>();
  return results ?? [];
}

/** A recording, but only if it belongs to a court in this venue. */
export function getRecordingInVenue(
  env: Env,
  recordingId: string,
  venueId: string,
): Promise<Recording | null> {
  return env.DB.prepare(
    `SELECT r.* FROM recordings r
       JOIN courts c ON c.id = r.court_id
      WHERE r.id = ? AND c.venue_id = ?`,
  )
    .bind(recordingId, venueId)
    .first<Recording>();
}

// ---- share links ---------------------------------------------------------------

export async function createShareLink(env: Env, link: ShareLink): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO share_links (token, recording_id, created_by, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      link.token,
      link.recording_id,
      link.created_by,
      link.expires_at,
      link.revoked,
      link.created_at,
    )
    .run();
}

/** Resolve a share token to its recording, enforcing revocation and expiry. */
export async function resolveShareToken(
  env: Env,
  token: string,
): Promise<{ link: ShareLink; recording: Recording } | null> {
  const link = await env.DB.prepare(`SELECT * FROM share_links WHERE token = ?`)
    .bind(token)
    .first<ShareLink>();
  if (!link || link.revoked === 1) return null;
  if (link.expires_at !== null && link.expires_at < Date.now()) return null;

  const recording = await getRecording(env, link.recording_id);
  if (!recording) return null;
  return { link, recording };
}

export async function listShareLinks(
  env: Env,
  recordingId: string,
): Promise<ShareLink[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM share_links WHERE recording_id = ? AND revoked = 0 ORDER BY created_at DESC`,
  )
    .bind(recordingId)
    .all<ShareLink>();
  return results ?? [];
}
