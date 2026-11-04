import { purgeOldAnalytics } from './analytics';
import { CourtCamera } from './court-camera';
import { findExpirableRecordings, findStaleRecordings, updateRecording } from './db';
import { incidentReport, reportIncident } from './incidents';
import { endOverdueMatches } from './matches';
import { runDigest, runHealthChecks } from './monitor';
import { notify } from './notify';
import * as a from './admin';
import * as h from './handlers';
import * as p from './player';
import { Router } from './router';
import * as s from './super';
import * as x from './expenses';
import type { Env } from './types';

// Durable Object class must be exported from the Worker entrypoint.
export { CourtCamera };

/** The nightly slot: retention, the stale sweep and the digest. */
const NIGHTLY_CRON = '0 3 * * *';

const router = new Router()
  // Client-side routes of the admin SPA, served the app shell explicitly.
  .get('/super', h.serveAppShell)
  .get('/super/finance', h.serveAppShell)
  // Admin sessions.
  .post('/api/auth/login', a.login)
  .post('/api/auth/logout', a.logout)
  .get('/api/auth/me', a.me)
  // Player-facing share links — deliberately unauthenticated, gated by an
  // unguessable, expiring, revocable token. This is what a QR code points at.
  .get('/s/:token', a.sharePage)
  .get('/s/:token/video', a.sharedVideo)
  .get('/s/:token/thumbnail', a.sharedThumbnail)
  // The QR sticker on the court. Starts a match or reports the court busy --
  // never reaches footage. See player.ts for why.
  .get('/c/:qrToken', p.courtPage)
  .post('/c/:qrToken/start', p.startFromCourt)
  // One match, reached only through its private link.
  .get('/m/:token', p.matchPage)
  .post('/m/:token/stop', p.stopFromMatch)
  .post('/m/:token/shared', p.markShared)
  // Funnel steps only the browser sees, and the one-tap feedback.
  .post('/m/:token/e', p.clientEvent)
  .post('/m/:token/feedback', p.submitFeedback)
  .get('/m/:token/video/:segment', p.matchVideo)
  .get('/m/:token/thumbnail/:segment', p.matchThumbnail)
  // Fleet surface — requires is_superadmin, which only the CLI can grant. Court
  // assignment lives here rather than on the venue surface: self-service
  // claiming let any club adopt any unassigned camera in the fleet.
  .get('/api/super/overview', s.overview)
  .get('/api/super/funnel', s.funnel)
  .get('/api/super/venues', s.listVenuesHandler)
  .post('/api/super/venues', s.createVenueHandler)
  .post('/api/super/venues/:id', s.updateVenueHandler)
  .post('/api/super/courts/:id', s.assignCourt)
  // Printable sign for the court: QR code plus the notice players see first.
  .get('/api/super/courts/:id/qr', s.qrCard)
  .post('/api/super/courts/:id/qr/rotate', s.rotateQr)
  .delete('/api/super/courts/:id', s.deleteCourtHandler)
  .post('/api/super/recordings/cleanup', s.cleanupRecordings)
  // Prove the alert path delivers, without waiting for a camera to break.
  .post('/api/super/test-alert', s.testAlert)
  .delete('/api/super/recordings/:id', s.purgeRecording)
  .put('/api/super/recordings/:id/thumbnail', s.uploadThumbnail)
  // Company spending -- company-wide, so super-admin only like the rest of
  // /api/super. `import` is what worker/scripts/import-expenses.mjs posts to.
  .get('/api/super/expenses', x.listExpensesHandler)
  .post('/api/super/expenses', x.createExpenseHandler)
  .post('/api/super/expenses/import', x.importExpensesHandler)
  .patch('/api/super/expenses/:id', x.updateExpenseHandler)
  .delete('/api/super/expenses/:id', x.deleteExpenseHandler)
  // Operator surface — every one of these requires a session and is scoped to
  // the admin's venue.
  .post('/api/recordings/:id/share', a.createShare)
  .get('/api/courts', h.getCourts)
  .get('/api/recordings', h.getRecordings)
  .get('/api/recordings/:id', h.getRecordingById)
  .get('/api/recordings/:id/download', h.downloadRecording)
  .post('/api/recordings/start', h.startRecording)
  .post('/api/recordings/stop', h.stopRecording)
  .post('/api/recordings/:id/complete', h.completeUpload)
  .post('/api/recordings/:id/abort', h.abortRecordingEndpoint)
  // Device surface: a camera resuming a match after a power cut opens its next
  // segment here, because nobody is at the browser when a Pi reboots mid-game.
  .post('/api/sessions/:sessionId/segment', h.openSessionSegment)
  // The fixer reporting back from CI, where there is no browser session.
  .post('/api/incidents/:id/report', reportIncidentHandler)
  .put('/api/recordings/:id/part/:n', h.uploadPart)
  .get('/api/recordings/:id/thumbnail', h.getThumbnail);

/** CI posts the investigation's outcome here, authenticated with the device token. */
async function reportIncidentHandler(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Record<string, string>,
): Promise<Response> {
  if (h.deviceUnauthorized(req, env)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const payload = (await req.json().catch(() => ({}))) as {
    status?: string;
    prUrl?: string | null;
    summary?: string;
  };
  return incidentReport(env, params.id!, payload);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Camera agents open a persistent WebSocket here; hand it to the court's DO.
    if (url.pathname === '/agent') {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      if (env.DEVICE_TOKEN && url.searchParams.get('token') !== env.DEVICE_TOKEN) {
        return new Response('unauthorized', { status: 401 });
      }
      const courtId = url.searchParams.get('courtId');
      if (!courtId) return new Response('courtId required', { status: 400 });
      const stub = env.COURT_CAMERA.get(env.COURT_CAMERA.idFromName(courtId));
      return stub.fetch(req);
    }

    // Without this, any thrown error surfaces as a bare 500 with nothing logged,
    // which makes a failing endpoint effectively undiagnosable in production.
    try {
      const matched = await router.handle(req, env, ctx);
      if (matched) return matched;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[${req.method} ${url.pathname}]`, error);
      // Every unhandled 500 is a fault nobody would otherwise see until someone
      // read the logs. Fire and forget: an incident reporter that can delay or
      // fail the response would just be a second way for this error to hurt.
      ctx.waitUntil(
        reportIncident(env, {
          summary: `${req.method} ${url.pathname} failed: ${detail}`,
          detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
        }),
      );
      return new Response(JSON.stringify({ error: 'Internal error', detail }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Everything else is the static web UI.
    return env.ASSETS.fetch(req);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        // Two cadences. Health has to be minutes, because a camera that dies the
        // night before a booked match is no use discovered the next morning --
        // and absence of a heartbeat is only ever found by looking. Retention
        // and the digest stay nightly; there is nothing to gain from sweeping
        // storage every five minutes.
        if (event.cron === NIGHTLY_CRON) {
          await runStaleSweep(env);
          await runRetention(env);
          await runDigest(env);
          // Last, so it can never hold up video retention or the digest.
          await runAnalyticsRetention(env);
          return;
        }
        await runHealthChecks(env);
        // Backstop for the court's alarm. A lost alarm means a camera recording
        // an empty court until the 5 h stale sweep, filling the Pi's disk.
        await endOverdueMatches(env);
        // Cheap, and it releases an abandoned multipart upload in minutes rather
        // than waiting for the night.
        await runStaleSweep(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

/**
 * Finalize recordings that never reached a terminal state. Each one holds an
 * un-aborted R2 multipart upload, which is billed and does not show up in a
 * bucket listing -- so without this sweep they accumulate invisibly.
 *
 * Runs before retention so a row cleaned up here is in `failed` by the time
 * retention looks at it.
 */
async function runStaleSweep(env: Env): Promise<void> {
  const stale = await findStaleRecordings(env);
  for (const rec of stale) {
    await h.abortRecording(env, rec, 'abandoned: upload never completed');
  }
  if (stale.length > 0) {
    console.log(`[sweep] finalized ${stale.length} abandoned recording(s)`);
    // Worth an email: every row here is footage somebody expected to exist.
    await notify(env, {
      key: 'stale-sweep',
      severity: 'warning',
      subject: `${stale.length} recording(s) abandoned and cleaned up`,
      body:
        stale
          .map((r) => `  ${r.id} (court ${r.court_id}, ${r.status}, ${r.bytes} bytes)`)
          .join('\n') +
        `\n\nEach held an open R2 multipart upload, now aborted. A recording reaching ` +
        `this sweep means its camera never finished delivering it.`,
    });
  }
}

/** Delete unpurchased, ready recordings older than RETENTION_DAYS from R2. */
async function runRetention(env: Env): Promise<void> {
  const days = Number(env.RETENTION_DAYS) || 14;
  const cutoff = Date.now() - days * 86_400_000;
  const expirable = await findExpirableRecordings(env, cutoff);
  for (const rec of expirable) {
    // Thumbnail goes with the video: an expired recording has no content left,
    // and a surviving thumbnail would be an orphan nothing ever cleans up.
    await h.deleteRecordingObjects(env, rec);
    await updateRecording(env, rec.id, { status: 'expired', thumbnail_key: null });
  }
  console.log(
    `[retention] expired ${expirable.length} recording(s) older than ${days}d`,
  );
}

/**
 * Funnel events and feedback are kept for ANALYTICS_RETENTION_DAYS, by their own
 * timestamp. Videos have their own, much shorter, retention above.
 */
async function runAnalyticsRetention(env: Env): Promise<void> {
  const deleted = await purgeOldAnalytics(env);
  console.log(
    `[retention] deleted ${deleted.funnel_events} funnel event(s), ${deleted.feedback} feedback row(s)`,
  );
}
