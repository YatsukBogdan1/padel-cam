// Telling a human that something broke.
//
// Until now nothing anywhere noticed a dead camera: `padel-club-court-1` sat
// off the network for twelve hours and the club found out before we did. A
// camera that dies the night before a booked match has to page someone.
//
// Dedupe is the whole feature, not a detail. An alerting system that sends one
// email per cron tick for a court that is offline overnight gets muted within a
// week, and a muted alerting system is worse than none -- it costs the same and
// buys the illusion of coverage.

import type { Env } from './types';

export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  /**
   * Dedupe identity. Everything about one ongoing condition must share a key --
   * `court-offline:court-1`, not a key with a timestamp in it.
   */
  key: string;
  severity: Severity;
  subject: string;
  body: string;
  /** Override the severity default. */
  cooldownMs?: number;
}

/**
 * How long the same key stays quiet after firing. Critical conditions repeat
 * often enough to stay visible; an ongoing condition repeats rarely enough to
 * stay ignorable.
 */
const COOLDOWN: Record<Severity, number> = {
  critical: 30 * 60_000,
  warning: 2 * 60 * 60_000,
  info: 6 * 60 * 60_000,
};

/**
 * Send an alert unless an identical one went out recently.
 *
 * Returns whether it was actually sent, so callers can log the difference
 * between "nothing wrong" and "wrong, but you already know".
 */
export async function notify(env: Env, alert: Alert): Promise<boolean> {
  const now = Date.now();
  const cooldown = alert.cooldownMs ?? COOLDOWN[alert.severity];

  const existing = await env.DB.prepare(`SELECT last_sent_at, count FROM alerts WHERE key = ?`)
    .bind(alert.key)
    .first<{ last_sent_at: number; count: number }>();

  if (existing && now - existing.last_sent_at < cooldown) {
    // Still inside the quiet window: count it so the next email can say how long
    // this has been going on, but do not send.
    await env.DB.prepare(`UPDATE alerts SET count = count + 1 WHERE key = ?`)
      .bind(alert.key)
      .run();
    return false;
  }

  const repeated = existing ? ` (${existing.count + 1} occurrences since last email)` : '';
  const sent = await send(env, alert, repeated);

  if (sent) {
    await env.DB.prepare(
      `INSERT INTO alerts (key, last_sent_at, count, last_body)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET last_sent_at = excluded.last_sent_at,
                                      count = 1,
                                      last_body = excluded.last_body`,
    )
      .bind(alert.key, now, alert.body.slice(0, 1000))
      .run();
  }
  return sent;
}

/**
 * Clear a resolved condition, so the next occurrence emails immediately instead
 * of being swallowed by a cooldown left over from last week.
 */
export async function clearAlert(env: Env, key: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM alerts WHERE key = ?`).bind(key).run();
}

/**
 * The transport, kept behind this one function on purpose.
 *
 * Two implementations, chosen by which credential exists. Cloudflare Email
 * Sending is the better long-term home -- native binding, no third party -- but
 * it requires the `from` address to be on a domain onboarded to the account,
 * and a project on *.workers.dev has no such domain. Rather than
 * ship alerting that silently never delivers, Resend carries it until a domain
 * exists, at which point removing RESEND_API_KEY switches back with no code
 * change.
 *
 * Either way a failure only logs. This is called from error paths and from the
 * cron that also runs retention; a notifier that can throw is just another way
 * for the original problem to get worse.
 */
async function send(env: Env, alert: Alert, repeated: string): Promise<boolean> {
  const to = env.ALERT_TO;
  const line = `[${alert.severity}] ${alert.subject}`;
  const body = `${alert.body}${repeated}\n\n-- Padel Smart-Cam`;
  const subject = `${SEVERITY_MARK[alert.severity]} ${alert.subject}`;
  const html = `<pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(body)}</pre>`;

  if (!to) {
    console.log(`[notify] (no ALERT_TO) ${line}\n${alert.body}`);
    return false;
  }

  try {
    if (env.RESEND_API_KEY) {
      await sendViaResend(env, to, subject, body, html);
    } else if (env.EMAIL && env.ALERT_FROM) {
      await env.EMAIL.send({
        to,
        from: { email: env.ALERT_FROM, name: FROM_NAME },
        subject,
        text: body,
        html,
      });
    } else {
      // Expected in local dev, and on an account with neither transport set up.
      console.log(`[notify] (no transport configured) ${line}\n${alert.body}`);
      return false;
    }
    console.log(`[notify] sent ${line}`);
    return true;
  } catch (error) {
    console.error(`[notify] send failed for ${line}: ${String(error)}`);
    return false;
  }
}

/**
 * Resend's REST API.
 *
 * The default `from` is their shared onboarding domain, which needs no DNS and
 * no domain of your own -- with one catch worth knowing before you wonder why
 * nothing arrives: it will ONLY deliver to the address the Resend account was
 * registered with. That is exactly this system's shape (alerts go to one
 * person), so it is a fit rather than a workaround, but the moment ALERT_TO
 * becomes someone else, a real sending domain has to be verified in Resend.
 */
async function sendViaResend(
  env: Env,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<void> {
  const from = env.ALERT_FROM || 'onboarding@resend.dev';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${from}>`,
      to: [to],
      subject,
      text,
      html,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    // Quote what Resend said: "You can only send testing emails to your own
    // address" is the one people hit first, and it is not obvious from a status
    // code alone.
    throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

const FROM_NAME = 'Padel Smart-Cam';
const SEVERITY_MARK: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟠',
  info: '🟢',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
