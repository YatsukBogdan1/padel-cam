/**
 * The player funnel: where people give up between scanning the sticker and
 * keeping the video.
 *
 * Counted by distinct visit (before Start) and distinct match (after), never by
 * raw events -- a phone refreshing a page or a player scrubbing a video must not
 * look like more interest. And only from browsers: a link pasted into WhatsApp is
 * fetched by WhatsApp's own servers to build the preview, which would otherwise
 * read as "the group opened the link" for every single share.
 */
import type { Env } from './types';

/** Steps the server records itself, from requests that prove they happened. */
export type ServerStep =
  /** Court page opened. detail: ready | busy | offline | returning */
  | 'scan'
  /** Start pressed. */
  | 'start_attempt'
  /** detail: no_consent | offline | invalid_time | busy | camera */
  | 'start_failed'
  | 'started'
  /** detail: manual | auto | staff */
  | 'stopped'
  /** Match page while recording or processing. detail: direct | share */
  | 'view_live'
  /** Match page once the video is ready. detail: direct | share */
  | 'view_ready'
  /** Match page past the free period. detail: direct | share */
  | 'view_locked'
  | 'download'
  /** detail: up | down */
  | 'feedback';

/** Steps only the browser can see. Everything a client sends is checked against this. */
const CLIENT_STEPS: Record<string, readonly string[] | null> = {
  share: ['whatsapp', 'native', 'copy'],
  play: null,
  watch_30s: null,
};
export type ClientStep = 'share' | 'play' | 'watch_30s';

export type FunnelStep = ServerStep | ClientStep;

export interface FunnelEvent {
  court_id: string;
  step: FunnelStep;
  detail?: string | null;
  visit_id?: string | null;
  session_id?: string | null;
}

/**
 * Link-preview fetchers and crawlers. Real browsers all send "Mozilla/"; the
 * preview bots that do also name themselves (iMessage claims to be
 * facebookexternalhit, Discord says Discordbot). Matched, never stored.
 */
const NOT_A_PERSON =
  /googlebot|bingbot|applebot|yandex|baiduspider|duckduckbot|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|skypeuripreview|pinterest|redditbot|embedly|headlesschrome|lighthouse|crawler|spider|preview/i;

export function isPerson(req: Request): boolean {
  const ua = req.headers.get('user-agent') ?? '';
  return ua.includes('Mozilla/') && !NOT_A_PERSON.test(ua);
}

/** A visit id as the court page issues it; anything else from the form is ignored. */
export function cleanVisitId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(value) ? value : null;
}

/** Validate a step the browser reported. Returns null for anything not on the list. */
export function clientStep(
  step: unknown,
  detail: unknown,
): { step: ClientStep; detail: string | null } | null {
  if (typeof step !== 'string' || !(step in CLIENT_STEPS)) return null;
  const allowed = CLIENT_STEPS[step];
  if (allowed === null) return { step: step as ClientStep, detail: null };
  if (typeof detail !== 'string' || !allowed!.includes(detail)) return null;
  return { step: step as ClientStep, detail };
}

export async function track(env: Env, event: FunnelEvent): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO funnel_events (court_id, visit_id, session_id, step, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      event.court_id,
      event.visit_id ?? null,
      event.session_id ?? null,
      event.step,
      event.detail ?? null,
      Date.now(),
    )
    .run();
}

/**
 * Track only when a person made the request. For page views and downloads --
 * the steps a preview bot or a script can trigger.
 */
export async function trackPerson(req: Request, env: Env, event: FunnelEvent): Promise<void> {
  if (isPerson(req)) await track(env, event);
}

// ---- feedback -------------------------------------------------------------------

export async function hasFeedback(env: Env, sessionId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS x FROM feedback WHERE session_id = ?`)
    .bind(sessionId)
    .first();
  return row !== null;
}

/** First rating wins. Returns false when the match was already rated. */
export async function rate(
  env: Env,
  sessionId: string,
  courtId: string,
  rating: 1 | -1,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO feedback (session_id, court_id, rating, comment, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  )
    .bind(sessionId, courtId, rating, Date.now())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export const MAX_COMMENT = 1000;

/** The optional follow-up. Only once, and only after a rating exists. */
export async function addComment(env: Env, sessionId: string, comment: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE feedback SET comment = ? WHERE session_id = ? AND comment IS NULL`,
  )
    .bind(comment.slice(0, MAX_COMMENT), sessionId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---- the readout ------------------------------------------------------------------

export interface FunnelReport {
  court_id: string;
  /** Distinct visits to the court page, by what it showed. */
  scans: number;
  scans_ready: number;
  scans_busy: number;
  scans_offline: number;
  scans_returning: number;
  /** Distinct visits that pressed Start. */
  start_attempts: number;
  /** Failed attempts by reason. */
  start_failed: Record<string, number>;
  /** Distinct matches from here on. */
  started: number;
  shared: number;
  shared_by: Record<string, number>;
  opened_by_others: number;
  stopped_manual: number;
  stopped_auto: number;
  returned_ready: number;
  played: number;
  watched_30s: number;
  downloaded: number;
  locked_views: number;
  feedback_up: number;
  feedback_down: number;
  comments: { rating: number; comment: string; created_at: number }[];
}

/**
 * Per court, since `since`. "Started" counts only player-started matches: staff
 * starts never scanned anything, and would make the funnel look healthier than
 * the sticker is.
 */
export async function funnelReport(env: Env, since: number): Promise<FunnelReport[]> {
  const { results: courts } = await env.DB.prepare(
    `SELECT id FROM courts WHERE venue_id IS NOT NULL ORDER BY id`,
  ).all<{ id: string }>();

  const reports: FunnelReport[] = [];
  for (const { id } of courts ?? []) {
    const [counts, failed, sharedBy, fb, comments] = await env.DB.batch([
      env.DB.prepare(
        `WITH e AS (SELECT * FROM funnel_events WHERE court_id = ?1 AND created_at >= ?2),
              player AS (SELECT DISTINCT session_id FROM e WHERE step = 'started')
         SELECT
           (SELECT COUNT(DISTINCT visit_id) FROM e WHERE step = 'scan') AS scans,
           (SELECT COUNT(DISTINCT visit_id) FROM e WHERE step = 'scan' AND detail = 'ready') AS scans_ready,
           (SELECT COUNT(DISTINCT visit_id) FROM e WHERE step = 'scan' AND detail = 'busy') AS scans_busy,
           (SELECT COUNT(DISTINCT visit_id) FROM e WHERE step = 'scan' AND detail = 'offline') AS scans_offline,
           (SELECT COUNT(DISTINCT visit_id) FROM e WHERE step = 'scan' AND detail = 'returning') AS scans_returning,
           (SELECT COUNT(DISTINCT visit_id) FROM e WHERE step = 'start_attempt') AS start_attempts,
           (SELECT COUNT(*) FROM player) AS started,
           (SELECT COUNT(DISTINCT session_id) FROM e WHERE step = 'share' AND session_id IN player) AS shared,
           (SELECT COUNT(DISTINCT session_id) FROM e WHERE step IN ('view_live','view_ready','view_locked')
              AND detail = 'share' AND session_id IN player) AS opened_by_others,
           (SELECT COUNT(DISTINCT session_id) FROM e WHERE step = 'stopped' AND detail = 'manual' AND session_id IN player) AS stopped_manual,
           (SELECT COUNT(DISTINCT session_id) FROM e WHERE step = 'stopped' AND detail = 'auto' AND session_id IN player) AS stopped_auto,
           (SELECT COUNT(DISTINCT session_id) FROM e WHERE step = 'view_ready' AND session_id IN player) AS returned_ready,
           (SELECT COUNT(DISTINCT session_id) FROM e WHERE step = 'play' AND session_id IN player) AS played,
           (SELECT COUNT(DISTINCT session_id) FROM e WHERE step = 'watch_30s' AND session_id IN player) AS watched_30s,
           (SELECT COUNT(DISTINCT session_id) FROM e WHERE step = 'download' AND session_id IN player) AS downloaded,
           (SELECT COUNT(DISTINCT session_id) FROM e WHERE step = 'view_locked' AND session_id IN player) AS locked_views`,
      ).bind(id, since),
      env.DB.prepare(
        `SELECT detail, COUNT(*) AS n FROM funnel_events
          WHERE court_id = ? AND created_at >= ? AND step = 'start_failed' GROUP BY detail`,
      ).bind(id, since),
      env.DB.prepare(
        `SELECT detail, COUNT(DISTINCT session_id) AS n FROM funnel_events
          WHERE court_id = ? AND created_at >= ? AND step = 'share' GROUP BY detail`,
      ).bind(id, since),
      env.DB.prepare(
        `SELECT SUM(rating = 1) AS up, SUM(rating = -1) AS down FROM feedback
          WHERE court_id = ? AND created_at >= ?`,
      ).bind(id, since),
      env.DB.prepare(
        `SELECT rating, comment, created_at FROM feedback
          WHERE court_id = ? AND created_at >= ? AND comment IS NOT NULL
          ORDER BY created_at DESC LIMIT 20`,
      ).bind(id, since),
    ]);

    const c = (counts!.results?.[0] ?? {}) as Record<string, number>;
    const byDetail = (rows: unknown[] | undefined) =>
      Object.fromEntries(
        ((rows ?? []) as { detail: string | null; n: number }[]).map((r) => [r.detail ?? 'unknown', r.n]),
      );
    const f = (fb!.results?.[0] ?? {}) as { up: number | null; down: number | null };

    reports.push({
      court_id: id,
      scans: c.scans ?? 0,
      scans_ready: c.scans_ready ?? 0,
      scans_busy: c.scans_busy ?? 0,
      scans_offline: c.scans_offline ?? 0,
      scans_returning: c.scans_returning ?? 0,
      start_attempts: c.start_attempts ?? 0,
      start_failed: byDetail(failed!.results),
      started: c.started ?? 0,
      shared: c.shared ?? 0,
      shared_by: byDetail(sharedBy!.results),
      opened_by_others: c.opened_by_others ?? 0,
      stopped_manual: c.stopped_manual ?? 0,
      stopped_auto: c.stopped_auto ?? 0,
      returned_ready: c.returned_ready ?? 0,
      played: c.played ?? 0,
      watched_30s: c.watched_30s ?? 0,
      downloaded: c.downloaded ?? 0,
      locked_views: c.locked_views ?? 0,
      feedback_up: f.up ?? 0,
      feedback_down: f.down ?? 0,
      comments: (comments!.results ?? []) as FunnelReport['comments'],
    });
  }
  return reports;
}

// ---- retention ------------------------------------------------------------------

/**
 * How long funnel steps and feedback (with its optional free-text comment) are
 * kept. A decision, not a deployment setting -- so it is a constant rather than a
 * `[vars]` entry that could drift between environments or from the notice.
 */
export const ANALYTICS_RETENTION_DAYS = 365;

/**
 * The only tables this purge may touch, each judged by its own `created_at`.
 * Deliberately not `matches`, `recordings`, `share_links` or `recording_events`.
 */
export const ANALYTICS_RETENTION_TABLES = ['funnel_events', 'feedback'] as const;

/** Rows per DELETE, and DELETEs per table per night: bounded work in the cron. */
const PURGE_BATCH = 1000;
const PURGE_MAX_BATCHES = 50;

/**
 * Delete funnel events and feedback older than ANALYTICS_RETENTION_DAYS. Runs
 * nightly. Deletes in bounded batches so one statement never scans and rewrites an
 * unbounded backlog; anything past the per-night cap is taken the next night.
 */
export async function purgeOldAnalytics(
  env: Env,
  now: number = Date.now(),
): Promise<Record<(typeof ANALYTICS_RETENTION_TABLES)[number], number>> {
  const cutoff = now - ANALYTICS_RETENTION_DAYS * 86_400_000;
  const deleted = { funnel_events: 0, feedback: 0 };
  for (const table of ANALYTICS_RETENTION_TABLES) {
    for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
      const res = await env.DB.prepare(
        `DELETE FROM ${table} WHERE rowid IN
           (SELECT rowid FROM ${table} WHERE created_at < ? LIMIT ?)`,
      )
        .bind(cutoff, PURGE_BATCH)
        .run();
      const n = res.meta.changes ?? 0;
      deleted[table] += n;
      if (n < PURGE_BATCH) break;
    }
  }
  return deleted;
}
