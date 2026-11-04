// The Worker, as an operator sees it.
//
// Every assertion goes through the real HTTP surface rather than reading D1
// directly, so the suite fails when a customer would notice -- not merely when a
// column is wrong.

import { writeFile } from 'node:fs/promises';

export interface Recording {
  id: string;
  court_id: string;
  status: 'recording' | 'uploading' | 'ready' | 'expired' | 'failed';
  bytes: number;
  started_at: number;
  stopped_at: number | null;
  error: string | null;
  warning: string | null;
  truncated: number;
  session_id: string | null;
  segment: number;
  stop_requested_at: number | null;
}

export interface CourtView {
  courtId: string;
  name: string | null;
  online: boolean;
  lastSeen: number | null;
  agentVersion: string | null;
}

export class Api {
  private cookie = '';

  constructor(readonly base: string) {}

  async login(email: string, password: string): Promise<{ isSuperadmin: boolean }> {
    const res = await fetch(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`);
    }
    const setCookie = res.headers.get('set-cookie') ?? '';
    this.cookie = setCookie.split(';')[0] ?? '';
    if (!this.cookie) throw new Error('login returned no session cookie');
    const body = (await res.json()) as { isSuperadmin?: boolean };
    return { isSuperadmin: body.isSuperadmin === true };
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), cookie: this.cookie },
      signal: AbortSignal.timeout(60_000),
    });
  }

  getJson<T>(path: string): Promise<T> {
    return this.json<T>(path);
  }

  async getText(path: string): Promise<string> {
    const res = await this.req(path);
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text;
  }

  postJson<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.req(path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async courts(): Promise<CourtView[]> {
    const body = await this.json<{ courts: CourtView[] }>('/api/courts');
    return body.courts;
  }

  async court(courtId: string): Promise<CourtView | undefined> {
    return (await this.courts()).find((c) => c.courtId === courtId);
  }

  async start(courtId: string): Promise<Recording> {
    return this.json<Recording>('/api/recordings/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ courtId }),
    });
  }

  /** Start, tolerating the 409 that a scenario may be deliberately provoking. */
  async tryStart(
    courtId: string,
  ): Promise<{ ok: boolean; recording?: Recording; error?: string; recordingId?: string }> {
    const res = await this.req('/api/recordings/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ courtId }),
    });
    const text = await res.text();
    if (!res.ok) {
      // A refused start still creates a `failed` row. The id comes back in the
      // error body so it can be cleaned up rather than left behind on every run.
      let recordingId: string | undefined;
      try {
        recordingId = (JSON.parse(text) as { recordingId?: string }).recordingId;
      } catch {
        // not JSON; nothing to reclaim
      }
      return { ok: false, error: text.slice(0, 400), recordingId };
    }
    return { ok: true, recording: JSON.parse(text) as Recording };
  }

  async stop(recordingId: string): Promise<{ ok: boolean; body: string }> {
    const res = await this.req('/api/recordings/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recordingId }),
    });
    return { ok: res.ok, body: (await res.text()).slice(0, 400) };
  }

  async recording(id: string): Promise<Recording> {
    return this.json<Recording>(`/api/recordings/${id}`);
  }

  async recordings(): Promise<Recording[]> {
    const body = await this.json<Recording[] | { recordings: Recording[] }>('/api/recordings');
    return Array.isArray(body) ? body : body.recordings;
  }

  /** Every segment of one match, in order. */
  async segments(sessionId: string): Promise<Recording[]> {
    const all = await this.recordings();
    return all
      .filter((r) => r.session_id === sessionId)
      .sort((a, b) => a.segment - b.segment);
  }

  /** Poll until the row reaches one of `statuses`, or give up. */
  async waitForStatus(
    id: string,
    statuses: Recording['status'][],
    timeoutMs: number,
    onTick?: (rec: Recording) => void,
  ): Promise<Recording> {
    const deadline = Date.now() + timeoutMs;
    let last: Recording | null = null;
    while (Date.now() < deadline) {
      last = await this.recording(id);
      onTick?.(last);
      if (statuses.includes(last.status)) return last;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(
      `recording ${id} was still "${last?.status ?? '?'}" after ${Math.round(timeoutMs / 1000)}s ` +
        `(wanted ${statuses.join(' or ')})`,
    );
  }

  /** Download to a local path and return the byte count actually received. */
  async download(id: string, toPath: string): Promise<number> {
    const res = await this.req(`/api/recordings/${id}/download`);
    if (!res.ok) throw new Error(`download ${id} -> HTTP ${res.status} ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(toPath, buf);
    return buf.length;
  }

  /** Super-admin: remove a recording, its video, thumbnail and share links. */
  async purge(id: string): Promise<boolean> {
    const res = await this.req(`/api/super/recordings/${id}`, { method: 'DELETE' });
    return res.ok;
  }
}

// ---- the player surface -----------------------------------------------------------

export interface Engagement {
  court_id: string;
  recordings: number;
  downloaded_recordings: number;
  views: number;
  downloads: number;
  locked_views: number;
  player_matches: number;
  shared_matches: number;
}

export interface FleetCourtView extends CourtView {
  venueId: string | null;
  freeUntil: number | null;
}

export interface Overview {
  courts: FleetCourtView[];
  engagement: Engagement[];
}

/** The super-admin calls the QR scenarios need. */
export class SuperApi {
  constructor(private readonly api: Api) {}

  overview(): Promise<Overview> {
    return this.api.getJson<Overview>('/api/super/overview');
  }

  /** The court's sticker token, issued on first print exactly as an operator would. */
  async qrToken(courtId: string): Promise<string> {
    const html = await this.api.getText(`/api/super/courts/${encodeURIComponent(courtId)}/qr`);
    const token = html.match(/\/c\/([A-Za-z0-9_-]+)/)?.[1];
    if (!token) throw new Error('QR card did not contain a /c/<token> URL');
    return token;
  }

  async setFreeUntil(courtId: string, freeUntil: number | null): Promise<void> {
    await this.api.postJson(`/api/super/courts/${encodeURIComponent(courtId)}`, { freeUntil });
  }

  async funnel(courtId: string): Promise<Record<string, number> | undefined> {
    const body = await this.api.getJson<{ courts: (Record<string, number> & { court_id: string })[] }>(
      '/api/super/funnel?days=7',
    );
    return body.courts.find((c) => c.court_id === courtId);
  }

  async engagement(courtId: string): Promise<Engagement | undefined> {
    return (await this.overview()).engagement.find((e) => e.court_id === courtId);
  }
}

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/**
 * A phone at the side of the court: no admin session, only what scanning the
 * sticker and pressing buttons gives it. Holds its own cookie jar of one, the
 * way a real browser holds the match cookie.
 */
export class Phone {
  cookie = '';

  constructor(readonly base: string) {}

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        ...(init.headers ?? {}),
        // Only browsers are counted in the funnel; node's default agent is not one.
        'user-agent': PHONE_UA,
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  }

  async page(path: string): Promise<{ status: number; html: string; location: string | null; headers: Headers }> {
    const res = await this.fetch(path);
    return { status: res.status, html: await res.text(), location: res.headers.get('location'), headers: res.headers };
  }

  /** End times the court page offers, as epoch ms. */
  async endOptions(qrToken: string): Promise<number[]> {
    const { html } = await this.page(`/c/${qrToken}`);
    return [...html.matchAll(/name="until" value="(\d+)"/g)].map((m) => Number(m[1]));
  }

  /** Press Start. Returns the match token when it worked, keeping the cookie. */
  async start(qrToken: string, until: number): Promise<{ status: number; token: string | null; body: string }> {
    const res = await this.fetch(`/c/${qrToken}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ until: String(until), consent: 'yes' }).toString(),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const location = res.headers.get('location');
    return {
      status: res.status,
      token: location?.startsWith('/m/') ? location.slice(3) : null,
      body: (await res.text()).slice(0, 400),
    };
  }

  async stop(token: string): Promise<number> {
    return (await this.fetch(`/m/${token}/stop`, { method: 'POST' })).status;
  }

  async shared(token: string): Promise<number> {
    return (await this.fetch(`/m/${token}/shared`, { method: 'POST' })).status;
  }

  /** Download one segment through the match link. Returns bytes, or the HTTP status. */
  async download(token: string, segment: number, toPath: string): Promise<{ status: number; bytes: number }> {
    const res = await this.fetch(`/m/${token}/video/${segment}?dl=1`);
    if (!res.ok) return { status: res.status, bytes: 0 };
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(toPath, buf);
    return { status: res.status, bytes: buf.length };
  }
}
