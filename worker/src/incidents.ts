// Routing a production error to something that can investigate it.
//
// The Worker files an issue with the diagnostic bundle and fires a
// repository_dispatch; a GitHub Action does the actual work. That split is not
// arbitrary -- a Worker cannot check out the repo, so a model editing code from
// here would be working blind, unable to run `npm run typecheck`, which is this
// project's only check. Plausible-looking patches that do not compile cost more
// review time than no patch at all.
//
// The guard rails matter more than the automation. An unbounded fixer turns one
// recurring fault into forty pull requests and a large bill, so: fingerprint
// dedupe, a hard daily budget, and the capture path is never patched
// unattended -- it gets a report and a human.

import { notify } from './notify';
import type { Env } from './types';

/** One investigation per distinct fault per day. */
const FINGERPRINT_COOLDOWN_MS = 24 * 60 * 60_000;
/** Ceiling on investigations per day, whatever happens. */
const DAILY_BUDGET = 5;

export interface IncidentInput {
  /** What broke, in one line. Becomes the issue title. */
  summary: string;
  /** Stack, response body, journal tail -- whatever helps. */
  detail: string;
  courtId?: string | null;
  recordingId?: string | null;
  agentVersion?: string | null;
}

/**
 * Record a production fault and, if it is new and within budget, ask the fixer
 * to look at it.
 *
 * Never throws: this is called from error paths, and an incident reporter that
 * can fail is just another way for the original error to get worse.
 */
export async function reportIncident(env: Env, input: IncidentInput): Promise<void> {
  try {
    const fingerprint = await fingerprintOf(input.summary);
    const now = Date.now();

    const recent = await env.DB.prepare(
      `SELECT id, created_at FROM incidents
        WHERE fingerprint = ? AND created_at > ?
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(fingerprint, now - FINGERPRINT_COOLDOWN_MS)
      .first<{ id: string; created_at: number }>();

    if (recent) {
      console.log(`[incident] ${fingerprint} already open as ${recent.id}`);
      return;
    }

    const todayCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM incidents WHERE dispatched_at > ?`,
    )
      .bind(now - 24 * 60 * 60_000)
      .first<{ n: number }>();

    const id = crypto.randomUUID();
    const overBudget = (todayCount?.n ?? 0) >= DAILY_BUDGET;

    await env.DB.prepare(
      `INSERT INTO incidents
         (id, fingerprint, court_id, recording_id, agent_version, summary, detail, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        fingerprint,
        input.courtId ?? null,
        input.recordingId ?? null,
        input.agentVersion ?? null,
        input.summary.slice(0, 500),
        input.detail.slice(0, 20_000),
        overBudget ? 'throttled' : 'open',
        now,
      )
      .run();

    if (overBudget) {
      // Something is wrong at a level the fixer will not solve, and spending the
      // rest of the day's budget on it would only bury the evidence.
      console.log(`[incident] daily budget spent; ${id} recorded but not dispatched`);
      await notify(env, {
        key: 'incident-budget',
        severity: 'critical',
        subject: 'Incident budget exhausted — something is failing repeatedly',
        body: `More than ${DAILY_BUDGET} distinct faults in 24h. Latest: ${input.summary}\n\nInvestigations are paused until the window rolls.`,
      });
      return;
    }

    await dispatch(env, id, fingerprint, input);
  } catch (error) {
    console.error(`[incident] could not record: ${String(error)}`);
  }
}

/** File the issue and wake the fixer workflow. */
async function dispatch(
  env: Env,
  id: string,
  fingerprint: string,
  input: IncidentInput,
): Promise<void> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    console.log(`[incident] ${id} recorded; no GitHub credentials, so no investigation`);
    await notify(env, {
      key: `incident:${fingerprint}`,
      severity: 'critical',
      subject: `Production error: ${input.summary}`,
      body: `${input.detail}\n\nNo fixer configured (GITHUB_TOKEN / GITHUB_REPO unset), so this needs a human.`,
    });
    return;
  }

  const body = [
    `**Incident** \`${id}\``,
    `**Fingerprint** \`${fingerprint}\``,
    input.courtId ? `**Court** \`${input.courtId}\`` : null,
    input.recordingId ? `**Recording** \`${input.recordingId}\`` : null,
    input.agentVersion ? `**Agent version** \`${input.agentVersion}\`` : null,
    '',
    '```',
    input.detail.slice(0, 15_000),
    '```',
    '',
    '_Filed automatically from production._',
  ]
    .filter((l) => l !== null)
    .join('\n');

  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'padel-smart-cam',
  };

  const issue = await gh(
    `https://api.github.com/repos/${env.GITHUB_REPO}/issues`,
    headers,
    { title: `[incident] ${input.summary.slice(0, 120)}`, body, labels: ['incident', 'automated'] },
  );
  const issueUrl = (issue as { html_url?: string } | null)?.html_url ?? null;
  const issueNumber = (issue as { number?: number } | null)?.number ?? null;

  await gh(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, headers, {
    event_type: 'padel-incident',
    client_payload: { incidentId: id, issueNumber, fingerprint, summary: input.summary },
  });

  await env.DB.prepare(
    `UPDATE incidents SET dispatched_at = ?, issue_url = ? WHERE id = ?`,
  )
    .bind(Date.now(), issueUrl, id)
    .run();

  console.log(`[incident] ${id} dispatched (${issueUrl ?? 'no issue url'})`);
}

async function gh(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error(`[incident] GitHub ${url} -> ${res.status} ${await res.text()}`);
    return null;
  }
  return res.status === 204 ? null : await res.json();
}

/**
 * Collapse an error into a stable identity, so one recurring fault is one
 * investigation. Volatile parts -- ids, timestamps, byte counts, addresses --
 * are stripped, or every occurrence would look new.
 */
async function fingerprintOf(summary: string): Promise<string> {
  const normalized = summary
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The fixer reporting back what it found. Called by the GitHub Action, which
 * holds the device token -- there is no browser session in CI.
 */
export async function incidentReport(
  env: Env,
  incidentId: string,
  payload: { status?: string; prUrl?: string | null; summary?: string },
): Promise<Response> {
  await env.DB.prepare(`UPDATE incidents SET status = ?, pr_url = ? WHERE id = ?`)
    .bind(payload.status ?? 'investigated', payload.prUrl ?? null, incidentId)
    .run();

  const incident = await env.DB.prepare(`SELECT * FROM incidents WHERE id = ?`)
    .bind(incidentId)
    .first<{ summary: string; issue_url: string | null }>();

  await notify(env, {
    key: `incident-report:${incidentId}`,
    severity: 'warning',
    subject: `Investigated: ${incident?.summary ?? incidentId}`,
    body:
      `${payload.summary ?? 'No summary provided.'}\n\n` +
      `Issue: ${incident?.issue_url ?? 'n/a'}\n` +
      `Pull request: ${payload.prUrl ?? 'none — needs a human'}\n\n` +
      `Nothing has been merged or deployed.`,
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  });
}
