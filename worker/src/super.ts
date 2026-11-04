/**
 * Fleet-wide operator surface. Everything here requires `is_superadmin`, which
 * is grantable only by worker/scripts/grant-super.mjs -- there is no endpoint
 * that can promote an account, for the same reason there is no signup route.
 *
 * This exists because court assignment used to be self-service: any club admin
 * could see every unassigned camera in the fleet and adopt it, including a Pi
 * that had just been installed at a different club. Assignment is now an
 * operator decision made here, and clubs only ever see courts already mapped to
 * their venue.
 */
import {
  createVenue,
  deleteCourt,
  deleteRecording,
  findStaleRecordings,
  getCourt,
  getRecording,
  listActiveRecordings,
  listAllCourts,
  listAllRecordings,
  listCourtEngagement,
  listVenues,
  setCourtFreeUntil,
  setCourtName,
  setCourtQrToken,
  setVenueSchedule,
  setCourtVenue,
  updateRecording,
} from './db';
import {
  abortRecording,
  deleteRecordingObjects,
  json,
  requireSuperAdmin,
  shapeCourt,
} from './handlers';
import qrcode from 'qrcode-generator';
import { funnelReport } from './analytics';
import { randomToken } from './auth';
import { isValidTimezone } from './matches';
import { clearAlert, notify } from './notify';
import type { Params } from './router';
import { thumbnailKey } from './ids';
import type { Env, Recording } from './types';

/** Fleet overview: every court, every venue, and everything mid-flight. */
export async function overview(req: Request, env: Env): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const [courts, venues, active, recordings, engagement] = await Promise.all([
    listAllCourts(env),
    listVenues(env),
    listActiveRecordings(env),
    listAllRecordings(env),
    listCourtEngagement(env, 0),
  ]);
  const stale = await findStaleRecordings(env);
  const staleIds = new Set(stale.map((r) => r.id));

  return json({
    venues,
    courts: courts.map((c) => ({
      ...shapeCourt(c),
      venueId: c.venue_id,
      venueName: c.venue_name,
    })),
    // `stale` marks the rows the nightly sweep would collect right now, so the
    // cleanup button and the cron agree on what counts as abandoned.
    active: active.map((r) => ({ ...r, stale: staleIds.has(r.id) })),
    // Every recording in the fleet, including finished ones. This is what makes
    // deleting footage possible from the browser instead of from the R2 console,
    // where picking the wrong object key is far easier and unrecoverable.
    recordings,
    // The free-period experiment's readout: do players open and keep the video?
    engagement,
  });
}

export async function listVenuesHandler(req: Request, env: Env): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;
  return json(await listVenues(env));
}

export async function createVenueHandler(req: Request, env: Env): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const { id, name } = (await req.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
  };
  const slug = id?.trim().toLowerCase();
  if (!slug || !name?.trim()) return json({ error: 'id and name are required' }, 400);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    return json({ error: 'id must be a lowercase slug, e.g. "my-club"' }, 400);
  }

  const venue = { id: slug, name: name.trim(), created_at: Date.now() };
  try {
    await createVenue(env, venue);
  } catch {
    return json({ error: `A venue with id "${slug}" already exists` }, 409);
  }
  return json(venue, 201);
}

/**
 * Assign a court to a venue, or to nobody with `venueId: null`. Reassignment is
 * allowed on purpose -- a camera that moves between clubs, or one assigned in
 * error, has to be correctable without touching the database by hand.
 */
export async function assignCourt(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const { venueId, name, freeUntil } = (await req.json().catch(() => ({}))) as {
    venueId?: string | null;
    name?: string | null;
    /** Epoch ms; null removes the paywall. */
    freeUntil?: number | null;
  };

  const court = await getCourt(env, params.id!);
  if (!court) return json({ error: 'Unknown court' }, 404);

  if (venueId !== undefined) {
    // Reject an unknown venue rather than silently orphaning the court behind a
    // foreign key that D1 does not enforce by default.
    if (venueId !== null) {
      const venues = await listVenues(env);
      if (!venues.some((v) => v.id === venueId)) {
        return json({ error: `Unknown venue "${venueId}"` }, 400);
      }
    }
    await setCourtVenue(env, params.id!, venueId);
  }
  if (name !== undefined) await setCourtName(env, params.id!, name?.trim() || null);
  if (freeUntil !== undefined) {
    if (freeUntil !== null && !Number.isFinite(freeUntil)) {
      return json({ error: 'freeUntil must be epoch milliseconds or null' }, 400);
    }
    await setCourtFreeUntil(env, params.id!, freeUntil);
  }

  const updated = await getCourt(env, params.id!);
  return json(updated ? shapeCourt(updated) : { error: 'Unknown court' });
}

export async function deleteCourtHandler(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const { deleted, recordings } = await deleteCourt(env, params.id!);
  if (!deleted) {
    return json(
      {
        error:
          recordings > 0
            ? `Court still has ${recordings} recording(s); delete those first`
            : 'Unknown court',
      },
      409,
    );
  }
  return json({ courtId: params.id, deleted: true });
}

/**
 * Finalize abandoned recordings: abort the orphaned R2 multipart upload and put
 * the row in `failed`. With no body it collects exactly what the nightly sweep
 * would; with `ids` it forces specific rows, for the ones already stuck from
 * before the sweep existed.
 */
export async function cleanupRecordings(req: Request, env: Env): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const { ids } = (await req.json().catch(() => ({}))) as { ids?: string[] };

  let targets: Recording[];
  if (ids?.length) {
    const found = await Promise.all(ids.map((id) => getRecording(env, id)));
    targets = found.filter(
      (r): r is Recording => r !== null && (r.status === 'recording' || r.status === 'uploading'),
    );
  } else {
    targets = await findStaleRecordings(env);
  }

  for (const rec of targets) {
    await abortRecording(env, rec, 'cleaned up by operator: upload never completed');
  }
  return json({ cleaned: targets.map((r) => r.id), count: targets.length });
}

/**
 * Store a first-frame thumbnail for an existing recording.
 *
 * Deliberately generated off-box and uploaded here rather than produced by the
 * camera agent: a thumbnail is a convenience for picking footage to delete, and
 * nothing that optional belongs in the capture path, where it would cost Pi CPU
 * mid-recording and add a failure mode to the one flow that must not have any.
 * worker/scripts/make-thumbnails.mjs is what calls this.
 */
export async function uploadThumbnail(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const rec = await getRecording(env, params.id!);
  if (!rec) return json({ error: 'Unknown recording' }, 404);
  if (!req.body) return json({ error: 'Empty thumbnail body' }, 400);

  const key = thumbnailKey(rec.id);
  await env.BUCKET.put(key, req.body, { httpMetadata: { contentType: 'image/jpeg' } });
  await updateRecording(env, rec.id, { thumbnail_key: key });
  return json({ id: rec.id, thumbnailKey: key });
}

/**
 * Hard-delete a recording row, its share links, and its R2 object. Separate
 * from cleanup on purpose: cleanup finalizes state and is safe to run in bulk,
 * this destroys footage.
 */
export async function purgeRecording(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const rec = await getRecording(env, params.id!);
  if (!rec) return json({ error: 'Unknown recording' }, 404);

  // Abort first: a row still mid-upload has an open MPU, and deleting the
  // object key would leave that upload dangling with nothing referencing it.
  if (rec.status === 'recording' || rec.status === 'uploading') {
    await abortRecording(env, rec, 'purged by operator');
  }
  // Re-read: abortRecording may have changed the row, and the thumbnail has to
  // go whatever the status was.
  const current = (await getRecording(env, rec.id)) ?? rec;
  await deleteRecordingObjects(env, current);
  await deleteRecording(env, rec.id);
  return json({ id: rec.id, purged: true });
}

/**
 * Send a test alert, to prove the notification path actually delivers.
 *
 * Worth a route rather than a comment in a runbook: alerting is the one feature
 * whose failure mode is silence, and silence is indistinguishable from a healthy
 * fleet. Verifying it should not require waiting for a camera to break.
 *
 * Clears its own dedupe key first, so it can be run twice in a row.
 */
export async function testAlert(req: Request, env: Env): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const transport = env.RESEND_API_KEY
    ? 'Resend'
    : env.EMAIL && env.ALERT_FROM
      ? 'Cloudflare Email Sending'
      : 'none configured';

  await clearAlert(env, 'test-alert');
  const sent = await notify(env, {
    key: 'test-alert',
    severity: 'info',
    subject: 'Test alert from Padel Smart-Cam',
    body:
      `If you are reading this, alerting works.\n\n` +
      `Transport: ${transport}\n` +
      `To: ${env.ALERT_TO ?? '(ALERT_TO not set)'}\n` +
      `From: ${env.ALERT_FROM ?? '(default)'}\n\n` +
      `Sent by ${admin.email} at ${new Date().toISOString()}.`,
  });

  return json({
    sent,
    transport,
    to: env.ALERT_TO ?? null,
    // `sent: false` is the useful answer -- it means the transport rejected it,
    // and the Worker log carries the reason.
    hint: sent ? 'check your inbox' : 'not sent — see the Worker log (npx wrangler tail)',
  });
}

/**
 * Set a venue's booking grid. The court page offers end times on it, in its
 * local time -- so a wrong timezone shows players the wrong clock.
 */
export async function updateVenueHandler(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const { timezone, slotMinutes } = (await req.json().catch(() => ({}))) as {
    timezone?: string;
    slotMinutes?: number;
  };
  if (!timezone || !isValidTimezone(timezone)) {
    return json({ error: 'timezone must be an IANA zone, e.g. "Europe/Lisbon"' }, 400);
  }
  // Must divide an hour, or the grid drifts off the clock.
  if (!slotMinutes || ![15, 20, 30, 60].includes(slotMinutes)) {
    return json({ error: 'slotMinutes must be 15, 20, 30 or 60' }, 400);
  }
  if (!(await setVenueSchedule(env, params.id!, timezone, slotMinutes))) {
    return json({ error: 'Unknown venue' }, 404);
  }
  return json({ id: params.id, timezone, slotMinutes });
}

/**
 * The printable sign for a court: QR code plus the notice players must see
 * before they are filmed. Issues the court's QR token on first use, so a court
 * has no live sticker URL until someone actually prints one.
 */
export async function qrCard(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const court = await getCourt(env, params.id!);
  if (!court) return json({ error: 'Unknown court' }, 404);
  if (!court.venue_id) return json({ error: 'Assign the court to a venue first' }, 409);
  const venue = (await listVenues(env)).find((v) => v.id === court.venue_id);

  let token = court.qr_token;
  if (!token) {
    token = randomToken(12);
    await setCourtQrToken(env, court.id, token);
  }
  const url = `${new URL(req.url).origin}/c/${token}`;
  return new Response(qrCardHtml(url, court.name ?? court.id, venue?.name ?? '', env), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Replace a court's QR token, killing every printed sticker for it. For a
 * sticker being abused -- someone who photographed it starting recordings
 * remotely. Print the new card before rotating: the old one dies immediately.
 */
export async function rotateQr(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;
  const court = await getCourt(env, params.id!);
  if (!court) return json({ error: 'Unknown court' }, 404);
  await setCourtQrToken(env, court.id, randomToken(12));
  return json({ courtId: court.id, rotated: true });
}

function qrCardHtml(url: string, courtName: string, venueName: string, env: Env): string {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  const retention = Number(env.RETENTION_DAYS) || 14;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>QR card — ${esc(courtName)}</title>
<style>
  @page { size: A5; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin:0; background:#fff; color:#111; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  .card { max-width:148mm; margin:0 auto; padding:10mm 0; text-align:center; }
  h1 { font-size:30pt; margin:0 0 2mm; letter-spacing:-.02em; }
  .sub { font-size:13pt; margin:0 0 6mm; }
  .qr svg { width:90mm; height:90mm; }
  .court { font-size:16pt; font-weight:600; margin:4mm 0 0; }
  .notice { margin-top:8mm; padding-top:4mm; border-top:1px solid #ccc; text-align:left;
            font-size:8.5pt; line-height:1.45; color:#333; }
  .url { font-family:ui-monospace,monospace; font-size:8pt; color:#666; margin-top:3mm; word-break:break-all; }
  .noprint { margin:16px auto; text-align:center; font-size:14px; }
  @media print { .noprint { display:none; } }
</style></head><body>
<p class="noprint"><button onclick="window.print()">Print</button>
  &nbsp; Laminate it and fix it at eye level by the court door.</p>
<div class="card">
  <h1>Record your match</h1>
  <p class="sub">Scan, pick when your booking ends, press Start.<br>The video comes to your phone.</p>
  <div class="qr">${svg}</div>
  <p class="court">${esc(courtName)}</p>
  <div class="notice">
    <strong>Camera on this court.</strong> It records only when a player on this court starts it,
    and stops automatically at the end of the chosen time. Video only, no sound, of this court only.
    Only the people who started the recording, and those they share the link with, can watch it.
    Videos are deleted after ${retention} days. Any player can stop a recording from the match
    page, or ask staff. Controller: ${esc(venueName)}. To object or request deletion, ask at reception.
  </div>
  <p class="url">${esc(url)}</p>
</div></body></html>`;
}

/**
 * Where players give up, per court, over the last `days` (7 or 30). The whole
 * point of the sticker experiment: a funnel shows WHICH step leaks, where a
 * download count alone only shows that something does.
 */
export async function funnel(req: Request, env: Env): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;
  const days = new URL(req.url).searchParams.get('days') === '30' ? 30 : 7;
  const since = Date.now() - days * 86_400_000;
  return json({ days, since, courts: await funnelReport(env, since) });
}
