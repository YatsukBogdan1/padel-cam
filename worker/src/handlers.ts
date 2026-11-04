import { track } from './analytics';
import { currentAdmin } from './auth';
import {
  addRecordingBytes,
  createRecording,
  getCourtInVenue,
  getRecording,
  getRecordingInVenue,
  getVenue,
  listCourtsForVenue,
  listRecordingsForVenue,
  listSessionSegments,
  recordEvent,
  updateRecording,
} from './db';
import { newRecordingId, objectKey } from './ids';
import { MAX_MATCH_MS, endTimeOptions, startMatch } from './matches';
import { notify } from './notify';
import type { Params } from './router';
import { isOnline } from './types';
import type { Admin, CameraCommandInput, Court, Env, Recording, UploadedPart } from './types';

/**
 * Resolve the signed-in admin or produce a 401. Every operator-facing endpoint
 * goes through this: scoping is enforced here in the Worker, never by filtering
 * in the UI.
 */
export async function requireAdmin(
  req: Request,
  env: Env,
): Promise<Admin | Response> {
  const admin = await currentAdmin(req, env);
  return admin ?? json({ error: 'Not signed in' }, 401);
}

/**
 * Gate for the fleet-wide surface. 404 rather than 403 for a signed-in
 * non-super admin: a club operator has no business learning that the route
 * exists at all.
 */
export async function requireSuperAdmin(
  req: Request,
  env: Env,
): Promise<Admin | Response> {
  const admin = await currentAdmin(req, env);
  if (!admin) return json({ error: 'Not signed in' }, 401);
  if (admin.is_superadmin !== 1) return json({ error: 'Not found' }, 404);
  return admin;
}

/**
 * Abort a recording's multipart upload and put the row in `failed` with a
 * reason. Every path that gives up on a recording goes through here, because
 * the R2 upload is the part that leaks silently: an un-aborted MPU is billed
 * and does not appear in a bucket listing.
 */
export async function abortRecording(
  env: Env,
  rec: Recording,
  reason: string,
): Promise<void> {
  if (rec.object_key && rec.upload_id) {
    try {
      await env.BUCKET.resumeMultipartUpload(rec.object_key, rec.upload_id).abort();
    } catch (error) {
      // An already-completed or already-aborted upload is not a problem; the
      // row still needs its terminal status.
      console.log(`[abort] ${rec.id}: ${String(error)}`);
    }
  }
  await updateRecording(env, rec.id, { status: 'failed', error: reason.slice(0, 500) });

  // A failed recording is footage somebody expected to exist, so this is pushed
  // rather than waiting to be noticed by a sweep. Keyed by court, not by
  // recording: a camera failing every start should be one conversation, not
  // twenty emails.
  await notify(env, {
    key: `recording-failed:${rec.court_id}`,
    severity: 'critical',
    subject: `Recording failed on ${rec.court_id}`,
    body:
      `Recording ${rec.id} failed after ${rec.bytes} bytes.\n\n` +
      `Reason: ${reason}\n\n` +
      `"failed to acquire camera" usually means something else still holds the ` +
      `device -- an rpicam preview left running after aiming it is the usual culprit.`,
  });
}

/**
 * Delete every R2 object belonging to a recording. Kept in one place because
 * the video and its thumbnail are separate keys, and forgetting the second one
 * is exactly how invisible orphans accumulate.
 */
export async function deleteRecordingObjects(env: Env, rec: Recording): Promise<void> {
  const keys = [rec.object_key, rec.thumbnail_key].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );
  if (keys.length > 0) await env.BUCKET.delete(keys);
}

/**
 * Serve the admin SPA's shell for a client-side route such as /super.
 *
 * This exists so `not_found_handling` can stay off: the "single-page-application"
 * mode answers document navigations from the assets router before the Worker is
 * reached, which broke share links and file downloads. Naming the SPA's routes
 * here keeps the fallback narrow and explicit.
 */
export function serveAppShell(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = '/index.html';
  return env.ASSETS.fetch(new Request(url, { headers: req.headers }));
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Extract a device token from `Authorization: Bearer` or a `?token=` query param. */
export function deviceToken(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return new URL(req.url).searchParams.get('token');
}

/** True when a device request should be rejected. No-op when DEVICE_TOKEN is unset. */
export function deviceUnauthorized(req: Request, env: Env): boolean {
  if (!env.DEVICE_TOKEN) return false; // auth disabled
  return deviceToken(req) !== env.DEVICE_TOKEN;
}

/**
 * Relay a command to a court's camera via its Durable Object, and wait for the
 * agent to acknowledge it. A non-ok response means the command did not reach a
 * running agent -- either nothing is connected, or the socket is half-open.
 */
/**
 * Delivers a command body to the court's camera and resolves with the DO's
 * answer. The default goes through the DO stub; code already running INSIDE the
 * court's DO (its auto-stop alarm) must relay directly instead -- a DO fetching
 * its own stub waits on itself, the agent's ack cannot be delivered, and the
 * command times out as "unacknowledged" after the socket is torn down.
 */
export type Relay = (body: string) => Promise<Response>;

export async function commandCourt(
  env: Env,
  courtId: string,
  command: CameraCommandInput,
  relay?: Relay,
): Promise<{ ok: boolean; detail: string }> {
  // Every command is acknowledged. The fire-and-forget fallback that used to
  // live here -- for agents predating acknowledgement -- reported a successful
  // start for cameras that were never reached, which is the failure that cost a
  // venue visit. A Pi too old to acknowledge must fail loudly instead.
  const body = { ...command, commandId: crypto.randomUUID() };

  const res = relay
    ? await relay(JSON.stringify(body))
    : await env.COURT_CAMERA.get(env.COURT_CAMERA.idFromName(courtId)).fetch(
        'https://do/command',
        { method: 'POST', body: JSON.stringify(body) },
      );
  return { ok: res.ok, detail: res.ok ? '' : await res.text() };
}

export async function getCourts(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  // Unassigned cameras are deliberately absent: a club can no longer see, let
  // alone adopt, a Pi that has not been assigned to it. Assignment moved to the
  // super-admin surface.
  const [mine, venue] = await Promise.all([
    listCourtsForVenue(env, admin.venue_id),
    getVenue(env, admin.venue_id),
  ]);
  return json({
    courts: mine.map(shapeCourt),
    // The same grid players are offered at the court, so staff and players
    // book matches the same way.
    endOptions: venue ? endTimeOptions(venue) : [],
  });
}

/**
 * A court as the browser sees it. `online` is computed from `last_seen`, not
 * read from the stored flag -- a Pi that loses power never sends a close, so
 * the stored flag stays 1 indefinitely.
 */
export function shapeCourt(court: Court): {
  courtId: string;
  name: string | null;
  online: boolean;
  lastSeen: number | null;
  agentVersion: string | null;
  freeUntil: number | null;
} {
  return {
    courtId: court.id,
    name: court.name,
    online: isOnline(court),
    lastSeen: court.last_seen,
    agentVersion: court.agent_version,
    freeUntil: court.free_until,
  };
}

export async function getRecordings(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;
  return json(await listRecordingsForVenue(env, admin.venue_id));
}

export async function getRecordingById(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  const rec = await getRecordingInVenue(env, params.id!, admin.venue_id);
  return rec ? json(rec) : json({ error: 'Unknown recording' }, 404);
}

export async function startRecording(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  const { courtId, bookedUntil } = (await req.json().catch(() => ({}))) as {
    courtId?: string;
    /** Epoch ms. Omitted, staff get the longest allowed match and stop it by hand. */
    bookedUntil?: number;
  };
  if (!courtId) return json({ error: 'courtId required' }, 400);

  // 404 rather than 403: don't confirm that another venue's court exists.
  if (!(await getCourtInVenue(env, courtId, admin.venue_id))) {
    return json({ error: 'Unknown court' }, 404);
  }

  const result = await startMatch(
    env,
    courtId,
    bookedUntil ?? Date.now() + MAX_MATCH_MS,
    'staff',
  );
  if (!result.ok) {
    // Name the row. A failed start still leaves a `failed` recording behind --
    // deliberately, so the operator can see why -- but returning only a message
    // meant no caller could link its attempt to that row, or clean it up.
    return json({ error: result.error, recordingId: result.recordingId }, result.status);
  }
  return json(result.recording, 201);
}

/**
 * Create one recording row with its R2 multipart upload already open, so the
 * agent can stream parts while still capturing. Shared by the operator's start
 * and by a returning agent opening the next segment after a power cut.
 */
export async function openSegment(
  env: Env,
  courtId: string,
  sessionId: string,
  segment: number,
): Promise<Recording> {
  const id = newRecordingId();
  const key = objectKey(id);
  const now = Date.now();

  const mpu = await env.BUCKET.createMultipartUpload(key);

  const rec: Recording = {
    id,
    court_id: courtId,
    status: 'recording',
    upload_id: mpu.uploadId,
    object_key: key,
    bytes: 0,
    purchased: 0,
    started_at: now,
    stopped_at: null,
    created_at: now,
    error: null,
    thumbnail_key: null,
    agent_claimed_at: now,
    truncated: 0,
    warning: null,
    session_id: sessionId,
    segment,
    stop_requested_at: null,
  };
  await createRecording(env, rec);
  return rec;
}

export async function stopRecording(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  const { recordingId } = (await req.json().catch(() => ({}))) as {
    recordingId?: string;
  };
  if (!recordingId) return json({ error: 'recordingId required' }, 400);

  const rec = await getRecordingInVenue(env, recordingId, admin.venue_id);
  if (!rec) return json({ error: 'Unknown recording' }, 404);

  const result = await stopLiveRecording(env, rec);
  if (result.kind === 'stopped' && rec.session_id) {
    await track(env, { court_id: rec.court_id, step: 'stopped', detail: 'staff', session_id: rec.session_id });
  }
  switch (result.kind) {
    case 'stamped':
    case 'stopped':
      return json(result.recording);
    case 'refused':
      return json({ error: result.error, recording: result.recording }, 409);
    case 'unacknowledged':
      return json(
        {
          error: `Camera did not acknowledge stop (${result.detail}). ` +
            `The recording will be finalized automatically if it does not complete.`,
        },
        409,
      );
  }
}

export type StopResult =
  /** Already stopping; the intent was recorded so a returning Pi reads it. */
  | { kind: 'stamped'; recording: Recording }
  | { kind: 'stopped'; recording: Recording }
  | { kind: 'refused'; error: string; recording: Recording | null }
  /** The row is stopped, but the camera was not reached. Not an abort -- see below. */
  | { kind: 'unacknowledged'; detail: string };

/**
 * Stop one recording. Every stop goes through here -- the operator's button, the
 * player's, auto-stop at the end of the booking -- because each rule below was
 * learned from a row that hung forever when one path skipped it.
 */
export async function stopLiveRecording(
  env: Env,
  rec: Recording,
  relay?: Relay,
): Promise<StopResult> {
  // Only a live recording can be stopped. Without this the old code wrote
  // `uploading` over whatever the row already held -- including `failed`, set
  // moments earlier by an agent whose capture never acquired the camera. That
  // row then sat in `uploading` forever, because nothing but /complete leaves
  // that state and the agent had already discarded the session.
  if (rec.status === 'uploading') {
    // Already stopping -- but the operator's INTENT still has to be recorded.
    // A camera shutting down cleanly reports `uploading` before the operator
    // gets to press stop, and returning here without stamping left
    // stop_requested_at null. A camera that then came back holding spooled data
    // would be told the session was still live and would open a new segment,
    // recording an empty court -- the exact thing stop_requested_at exists to
    // prevent, reached from the other side.
    const now = Date.now();
    await updateRecording(env, rec.id, { stop_requested_at: now });
    return { kind: 'stamped', recording: { ...rec, stop_requested_at: now } };
  }
  if (rec.status !== 'recording') {
    return { kind: 'refused', error: `Recording is ${rec.status}, not recording`, recording: rec };
  }

  // `stop_requested_at` is stamped here, before the relay. It is what a Pi
  // returning from a power cut reads to learn the operator already ended the
  // match, so it finalizes what it buffered instead of opening a new segment
  // and recording an empty court.
  const moved = await updateRecording(env, rec.id, {
    status: 'uploading',
    stopped_at: Date.now(),
    stop_requested_at: Date.now(),
  });
  if (!moved) {
    // The agent reported a terminal status between our read and our write.
    const current = await getRecording(env, rec.id);
    return { kind: 'refused', error: `Recording is ${current?.status ?? 'gone'}`, recording: current };
  }

  const sent = await commandCourt(
    env,
    rec.court_id,
    { type: 'stop', recordingId: rec.id },
    relay,
  );
  if (!sent.ok) {
    // Deliberately not aborted here. Part uploads travel over plain HTTP,
    // independent of this WebSocket, so an agent with a dead control socket may
    // still be mid-upload and about to call /complete. The stale sweep finalizes
    // it once the upload window has genuinely passed.
    return { kind: 'unacknowledged', detail: sent.detail };
  }

  return { kind: 'stopped', recording: { ...rec, status: 'uploading' } };
}

/**
 * The agent gives up on a recording: capture never produced a byte, or a stop
 * arrived for a session it no longer has. Without this the agent could only
 * report `failed` up the WebSocket, which left the R2 multipart upload orphaned.
 */
export async function abortRecordingEndpoint(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  if (deviceUnauthorized(req, env)) return json({ error: 'unauthorized' }, 401);
  const rec = await getRecording(env, params.id!);
  if (!rec) return json({ error: 'Unknown recording' }, 404);
  if (rec.status === 'ready' || rec.status === 'expired') {
    return json({ error: `Recording is already ${rec.status}` }, 409);
  }

  const { reason } = (await req.json().catch(() => ({}))) as { reason?: string };
  await abortRecording(env, rec, reason || 'aborted by camera agent');
  return json({ id: rec.id, status: 'failed' });
}

/**
 * A camera opening the next segment of a match it is already recording, after a
 * power cut interrupted the previous one.
 *
 * Device-authed rather than operator-authed: nobody is at the browser when a Pi
 * reboots at 21:40, which is the entire point. The session must still be live --
 * `resumePlanFor` has already decided that, and this re-checks it, because the
 * two run on separate connections and the operator may have pressed stop in
 * between.
 */
export async function openSessionSegment(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  if (deviceUnauthorized(req, env)) return json({ error: 'unauthorized' }, 401);

  const sessionId = params.sessionId!;
  const { courtId } = (await req.json().catch(() => ({}))) as { courtId?: string };
  if (!courtId) return json({ error: 'courtId required' }, 400);

  const siblings = await listSessionSegments(env, sessionId);
  if (siblings.length === 0) return json({ error: 'Unknown session' }, 404);
  if (siblings[0]!.court_id !== courtId) {
    return json({ error: 'Session belongs to another court' }, 403);
  }
  if (siblings.some((s) => s.stop_requested_at !== null)) {
    return json({ error: 'Session was stopped by the operator' }, 409);
  }
  if (siblings.some((s) => s.status === 'recording')) {
    return json({ error: 'Session already has a live segment' }, 409);
  }

  const next = Math.max(...siblings.map((s) => s.segment)) + 1;
  const rec = await openSegment(env, courtId, sessionId, next);
  return json(rec, 201);
}

/** Agent streams one multipart part here during recording. */
export async function uploadPart(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  if (deviceUnauthorized(req, env)) return json({ error: 'unauthorized' }, 401);
  const rec = await getRecording(env, params.id!);
  if (!rec || !rec.object_key || !rec.upload_id) {
    return json({ error: 'Unknown or uninitialized recording' }, 404);
  }
  const partNumber = Number(params.n);
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    return json({ error: 'Invalid part number' }, 400);
  }
  if (!req.body) return json({ error: 'Empty part body' }, 400);

  const mpu = env.BUCKET.resumeMultipartUpload(rec.object_key, rec.upload_id);
  const uploaded = await mpu.uploadPart(partNumber, req.body);

  // Incremented in SQL rather than read-modify-written. Parts used to arrive
  // strictly in order from one in-memory queue; a spool draining after an outage
  // can deliver them out of order and concurrently with a re-upload.
  const partBytes = Number(req.headers.get('content-length') ?? 0);
  await addRecordingBytes(env, rec.id, partBytes);

  return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
}

/** Agent posts the collected part list to finalize the object. */
export async function completeUpload(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  if (deviceUnauthorized(req, env)) return json({ error: 'unauthorized' }, 401);
  const rec = await getRecording(env, params.id!);
  if (!rec || !rec.object_key || !rec.upload_id) {
    return json({ error: 'Unknown or uninitialized recording' }, 404);
  }
  const { parts } = (await req.json().catch(() => ({}))) as { parts?: UploadedPart[] };
  if (!parts?.length) return json({ error: 'parts required' }, 400);

  // A recording the sweep or the agent already gave up on must not come back:
  // its multipart upload has been aborted, so completing it would fail anyway.
  if (rec.status !== 'recording' && rec.status !== 'uploading') {
    return json({ error: `Recording is ${rec.status}` }, 409);
  }

  const mpu = env.BUCKET.resumeMultipartUpload(rec.object_key, rec.upload_id);
  const object = await mpu.complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));

  // Take the size from R2 rather than trusting the running total. `uploadPart`
  // adds to `bytes` on every successful PUT, so a part that is retried -- after a
  // timeout, a dropped connection, a Worker deploy -- is counted twice while the
  // object contains it once. Observed as a recording reporting exactly 10 MiB
  // more than the camera captured, being two re-sent 5 MiB parts. The assembled
  // object's own size is the only number that cannot drift.
  const stoppedAt = rec.stopped_at ?? Date.now();
  const bytes = object.size;
  const warning = shortRecordingWarning({ ...rec, bytes }, stoppedAt);
  if (warning) {
    await notify(env, {
      key: `short-recording:${rec.court_id}`,
      severity: 'warning',
      subject: `Short recording on ${rec.court_id}`,
      body: `${warning}\n\nRecording ${rec.id}. The file is playable, but it is very likely missing most of the match.`,
    });
  }
  await updateRecording(env, rec.id, {
    status: 'ready',
    stopped_at: stoppedAt,
    bytes,
    ...(warning ? { warning } : {}),
  });
  return json({
    ...rec,
    status: 'ready',
    bytes,
    warning,
    downloadUrl: `/api/recordings/${rec.id}/download`,
  });
}

/**
 * A floor, not an estimate: below this a recording contains essentially nothing
 * regardless of what was in frame.
 *
 * This started life as "expected bytes per second" derived from the fleet's
 * ~10 Mbit/s target, and measuring a real camera showed why that was wrong.
 * H.264 bitrate is content-dependent -- a dim, static or low-detail scene
 * compresses to a fraction of a busy one. The home camera produces ~750 kbit/s
 * of perfectly valid video, so the old threshold would have flagged EVERY match
 * from it as short. An alert that fires on every recording is one nobody reads.
 *
 * The precise signal lives on the agent instead: capture ending without anyone
 * asking it to. That is content-independent and arrives as a `warning` patch.
 * This check only catches the unambiguous case that signal could miss -- a
 * capture that ran the whole time and produced almost no data.
 */
const MIN_BYTES_PER_SEC = 20_000; // ~160 kbit/s
/** Too brief to judge -- a deliberate 20-second test would always look short. */
const MIN_JUDGED_DURATION_MS = 120_000;

/**
 * Flag a recording that ran for a long time and produced almost nothing.
 *
 * The failure with no symptom: a camera that stalls forty minutes into a
 * sixty-minute match still completes, still says `ready`, and still plays -- it
 * is simply missing most of the game.
 */
function shortRecordingWarning(rec: Recording, stoppedAt: number): string | null {
  const durationMs = stoppedAt - rec.started_at;
  if (durationMs < MIN_JUDGED_DURATION_MS) return null;
  const perSec = rec.bytes / (durationMs / 1000);
  if (perSec >= MIN_BYTES_PER_SEC) return null;
  const minutes = Math.round(durationMs / 60_000);
  const gotMb = Math.round(rec.bytes / 1_048_576);
  return `Suspiciously little video: ${gotMb} MiB over ${minutes} min (${Math.round(perSec / 125)} kbit/s). Capture may have stalled.`;
}


/** Serve a recording's thumbnail to a signed-in operator, scoped to their venue. */
export async function getThumbnail(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  const rec = admin.is_superadmin === 1
    ? await getRecording(env, params.id!)
    : await getRecordingInVenue(env, params.id!, admin.venue_id);
  if (!rec?.thumbnail_key) return json({ error: 'No thumbnail' }, 404);

  return streamThumbnail(env, rec.thumbnail_key);
}

/**
 * A thumbnail is immutable once written — it is the first frame of a finished
 * capture — so it can be cached hard. That is what keeps a table of them from
 * re-fetching on every poll.
 */
export async function streamThumbnail(env: Env, key: string): Promise<Response> {
  const object = await env.BUCKET.get(key);
  if (!object) return json({ error: 'Thumbnail missing from storage' }, 404);
  return new Response(object.body, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'private, max-age=31536000, immutable',
      etag: object.httpEtag,
    },
  });
}

/** Stream the finished video from R2, honoring Range requests for seeking. */
export async function downloadRecording(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  // Previously unauthenticated: anyone holding a recording UUID could download it.
  // Players reach video through a share token instead (see serveSharedVideo).
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  // A super-admin reads across venues. They can already delete any recording
  // from the fleet surface, so withholding read access buys nothing -- and it
  // is what lets make-thumbnails.mjs cover every venue rather than only the one
  // its account happens to belong to.
  const rec =
    admin.is_superadmin === 1
      ? await getRecording(env, params.id!)
      : await getRecordingInVenue(env, params.id!, admin.venue_id);
  if (!rec || !rec.object_key) return json({ error: 'Unknown recording' }, 404);
  if (rec.status !== 'ready') return json({ error: `Recording is ${rec.status}` }, 409);

  // Club staff are the customer, so the free period does not gate them -- but
  // their downloads are interest too, counted apart from players'. Super-admin
  // reads (make-thumbnails.mjs ranges into every file) are tooling, not demand.
  const res = await streamRecording(req, env, rec.object_key, `${rec.id}.mp4`, 'attachment');
  if (res.ok && admin.is_superadmin !== 1 && isWholeFileRequest(req)) {
    ctx.waitUntil(recordEvent(env, rec, 'admin_download'));
  }
  return res;
}

/**
 * Stream an R2 object with Range support, shared by the admin download and the
 * player's share link. `inline` lets a phone play the video in the page instead
 * of forcing a download, which is what the QR flow needs.
 */
export async function streamRecording(
  req: Request,
  env: Env,
  key: string,
  filename: string,
  disposition: 'attachment' | 'inline',
): Promise<Response> {
  const range = parseRange(req.headers.get('range'));
  const object = await env.BUCKET.get(key, range ? { range } : undefined);
  if (!object) return json({ error: 'Object missing from storage' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  if (!headers.has('content-type')) headers.set('content-type', 'video/mp4');
  headers.set('content-disposition', `${disposition}; filename="${filename}"`);

  const objRange = object.range as { offset?: number; length?: number } | undefined;
  if (range && objRange) {
    const start = objRange.offset ?? 0;
    const len = objRange.length ?? object.size - start;
    const end = start + len - 1;
    headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
    headers.set('content-length', String(len));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('content-length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

/**
 * True for a request that starts at the beginning of the file. A player seeking
 * through a video issues dozens of Range requests, and a resumed download picks
 * up mid-file; counting any of those would turn one person into twenty.
 */
export function isWholeFileRequest(req: Request): boolean {
  const range = parseRange(req.headers.get('range'));
  return range === undefined || range.offset === 0;
}

/** Parse a single-range `bytes=start-end` header into an R2 range option. */
function parseRange(
  header: string | null,
): { offset: number; length?: number } | undefined {
  if (!header?.startsWith('bytes=')) return undefined;
  const spec = header.slice('bytes='.length).split(',')[0]!.trim();
  const [startStr, endStr] = spec.split('-');
  const start = Number(startStr);
  if (!Number.isFinite(start)) return undefined;
  if (endStr === '' || endStr === undefined) return { offset: start };
  const end = Number(endStr);
  if (!Number.isFinite(end) || end < start) return { offset: start };
  return { offset: start, length: end - start + 1 };
}
