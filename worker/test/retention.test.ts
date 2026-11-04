// Analytics retention: funnel events and feedback (which can hold a free-text
// comment) are deleted after 12 months by their own timestamp, in the nightly
// cron -- and nothing else is touched.

import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_RETENTION_DAYS, purgeOldAnalytics } from '../src/analytics';
import worker from '../src/index';

const DAY = 86_400_000;

/** One row of every table nearby, all `ageDays` old, keyed by `tag`. */
async function seedAll(now: number, ageDays: number, tag: string): Promise<void> {
  const at = now - ageDays * DAY;
  const courtId = `court-${tag}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO venues (id, name, created_at) VALUES ('club-r', 'Club', ?)`,
    ).bind(at),
    env.DB.prepare(
      `INSERT INTO courts (id, name, online, created_at, venue_id) VALUES (?, 'Court', 0, ?, 'club-r')`,
    ).bind(courtId, at),
    env.DB.prepare(
      `INSERT INTO funnel_events (court_id, visit_id, session_id, step, detail, created_at)
       VALUES (?, ?, ?, 'scan', 'ready', ?)`,
    ).bind(courtId, `v-${tag}`, `s-${tag}`, at),
    env.DB.prepare(
      `INSERT INTO feedback (session_id, court_id, rating, comment, created_at)
       VALUES (?, ?, 1, 'great', ?)`,
    ).bind(`s-${tag}`, courtId, at),
    env.DB.prepare(
      `INSERT INTO matches (session_id, court_id, token, booked_until, ends_at, started_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'player', ?)`,
    ).bind(`s-${tag}`, courtId, `t-${tag}`, at + 3_600_000, at + 3_600_000, at),
    env.DB.prepare(
      `INSERT INTO recording_events (recording_id, court_id, kind, created_at)
       VALUES (?, ?, 'view', ?)`,
    ).bind(`r-${tag}`, courtId, at),
  ]);
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

async function sessionsIn(table: 'funnel_events' | 'feedback'): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT session_id FROM ${table} ORDER BY session_id`,
  ).all<{ session_id: string }>();
  return results.map((r) => r.session_id);
}

describe('analytics retention', () => {
  it('is twelve months', () => {
    expect(ANALYTICS_RETENTION_DAYS).toBe(365);
  });

  it('deletes funnel events and feedback past 12 months, keeps the rest, touches nothing else', async () => {
    const now = Date.now();
    await seedAll(now, 366, 'old'); // just past the cutoff
    await seedAll(now, 364, 'recent'); // just inside it
    await seedAll(now, 20, 'fresh');

    const deleted = await purgeOldAnalytics(env, now);

    expect(deleted).toEqual({ funnel_events: 1, feedback: 1 });
    expect(await sessionsIn('funnel_events')).toEqual(['s-fresh', 's-recent']);
    expect(await sessionsIn('feedback')).toEqual(['s-fresh', 's-recent']);
    // Every other table keeps its 366-day-old rows.
    expect(await count('matches')).toBe(3);
    expect(await count('recording_events')).toBe(3);
    expect(await count('courts')).toBe(3);
    expect(await count('venues')).toBe(1);
  });

  it('works through a backlog bigger than one batch', async () => {
    const now = Date.now();
    const old = now - 400 * DAY;
    const stmts = [];
    for (let i = 0; i < 2_500; i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO funnel_events (court_id, step, created_at) VALUES ('court-bulk', 'scan', ?)`,
        ).bind(old),
      );
    }
    await env.DB.batch(stmts);
    await seedAll(now, 10, 'keep');

    const deleted = await purgeOldAnalytics(env, now);

    expect(deleted.funnel_events).toBe(2_500);
    expect(await sessionsIn('funnel_events')).toEqual(['s-keep']);
  });

  it('runs in the nightly cron, not the five-minute one', async () => {
    const now = Date.now();
    await seedAll(now, 366, 'old');

    const fiveMin = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: now, cron: '*/5 * * * *' }),
      env,
      fiveMin,
    );
    await waitOnExecutionContext(fiveMin);
    expect(await count('funnel_events')).toBe(1);
    expect(await count('feedback')).toBe(1);

    const nightly = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: now, cron: '0 3 * * *' }),
      env,
      nightly,
    );
    await waitOnExecutionContext(nightly);
    expect(await count('funnel_events')).toBe(0);
    expect(await count('feedback')).toBe(0);
    expect(await count('matches')).toBe(1);
    expect(await count('recording_events')).toBe(1);
  });
});
