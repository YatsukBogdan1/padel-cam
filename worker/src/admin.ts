/**
 * Admin session endpoints and the player-facing share flow.
 */
import {
  SESSION_TTL_SECONDS,
  SESSION_COOKIE,
  clearedSessionCookie,
  createSession,
  currentAdmin,
  deleteSession,
  isSecureRequest,
  randomToken,
  readCookie,
  sessionCookie,
  verifyPassword,
} from './auth';
import {
  createShareLink,
  getAdminByEmail,
  getCourt,
  getRecordingInVenue,
  getVenue,
  recordEvent,
  resolveShareToken,
} from './db';
import {
  isWholeFileRequest,
  json,
  requireAdmin,
  streamRecording,
  streamThumbnail,
} from './handlers';
import { HTML_LANG, LANG_CSS, langSwitch, resolveLang, STRINGS } from './i18n';
import type { Lang } from './i18n';
import type { Params } from './router';
import { isFree } from './types';
import type { Env, Recording, ShareLink } from './types';

const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---- sessions -----------------------------------------------------------------

export async function login(req: Request, env: Env): Promise<Response> {
  const { email, password } = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  if (!email || !password) {
    return json({ error: 'Email and password are required' }, 400);
  }

  const admin = await getAdminByEmail(env, email);
  // Verify against a dummy hash when the account is unknown, so a missing
  // account and a wrong password take the same time to answer.
  const stored =
    admin?.password_hash ??
    'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(password, stored);

  if (!admin || !ok) return json({ error: 'Incorrect email or password' }, 401);

  const session = await createSession(env, admin.id);
  const venue = await getVenue(env, admin.venue_id);
  return new Response(
    JSON.stringify({
      email: admin.email,
      venue: { id: admin.venue_id, name: venue?.name ?? admin.venue_id },
      isSuperadmin: admin.is_superadmin === 1,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': sessionCookie(
          session.token,
          SESSION_TTL_SECONDS,
          isSecureRequest(req),
        ),
      },
    },
  );
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await deleteSession(env, token);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': clearedSessionCookie(isSecureRequest(req)),
    },
  });
}

export async function me(req: Request, env: Env): Promise<Response> {
  const admin = await currentAdmin(req, env);
  if (!admin) return json({ error: 'Not signed in' }, 401);
  const venue = await getVenue(env, admin.venue_id);
  return json({
    email: admin.email,
    venue: { id: admin.venue_id, name: venue?.name ?? admin.venue_id },
    // Only decides whether the SPA offers the link. Every /api/super route
    // re-checks the flag server-side, so a forged response buys nothing.
    isSuperadmin: admin.is_superadmin === 1,
  });
}

// ---- share links ---------------------------------------------------------------

export async function createShare(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  const rec = await getRecordingInVenue(env, params.id!, admin.venue_id);
  if (!rec) return json({ error: 'Unknown recording' }, 404);
  if (rec.status !== 'ready') {
    return json({ error: `Recording is ${rec.status}, not ready to share` }, 409);
  }

  const now = Date.now();
  const link: ShareLink = {
    token: randomToken(16),
    recording_id: rec.id,
    created_by: admin.id,
    expires_at: now + SHARE_TTL_MS,
    revoked: 0,
    created_at: now,
  };
  await createShareLink(env, link);

  const url = new URL(req.url);
  return json({
    token: link.token,
    url: `${url.origin}/s/${link.token}`,
    expiresAt: link.expires_at,
  });
}

/** Whether a player may have this recording, given its court's free period. */
async function playerMayHave(env: Env, rec: Recording): Promise<boolean> {
  return isFree(rec, await getCourt(env, rec.court_id));
}

/** The page a player lands on after scanning the QR code. No login required. */
export async function sharePage(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const found = await resolveShareToken(env, params.token!);
  const lang = resolveLang(req);
  // The language switch re-renders this page with r=1: the same person, not another view.
  const switchTo = (to: Lang) => `/s/${params.token!}?r=1&lang=${to}`;
  const sw = langSwitch(lang, switchTo);
  let html = expiredHtml(lang, sw);
  if (found) {
    const rec = found.recording;
    const free = await playerMayHave(env, rec);
    // A locked view is still a player who came looking -- the closest thing to
    // demand we can measure before there is anything to pay with.
    if (new URL(req.url).searchParams.get('r') !== '1') {
      ctx.waitUntil(recordEvent(env, rec, free ? 'view' : 'locked_view'));
    }
    html = free
      ? sharePageHtml(lang, sw, params.token!, rec.started_at, rec.thumbnail_key !== null)
      : lockedHtml(lang, sw, params.token!, rec.started_at, rec.thumbnail_key !== null);
  }
  return new Response(html, {
    status: found ? 200 : 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // The token is in the URL: keep it out of Referer headers and search indexes.
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/**
 * Poster frame for the share page's video element, gated by the same token as
 * the video itself. Without it a player sees a black rectangle until they press
 * play.
 */
export async function sharedThumbnail(
  _req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const found = await resolveShareToken(env, params.token!);
  if (!found?.recording.thumbnail_key) return json({ error: 'No thumbnail' }, 404);
  return streamThumbnail(env, found.recording.thumbnail_key);
}

/**
 * The video behind a share link. `?dl=1` is the page's Download button: it is
 * served as an attachment and counted, while plain playback is not -- a player
 * scrubbing through a match would otherwise count as dozens of downloads.
 */
export async function sharedVideo(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const found = await resolveShareToken(env, params.token!);
  if (!found || !found.recording.object_key) {
    return json({ error: 'This link is no longer valid' }, 404);
  }
  if (found.recording.status !== 'ready') {
    return json({ error: 'This recording is not ready yet' }, 409);
  }
  // Enforced here, not only by hiding the player on the page: the video URL is
  // guessable from the page's own token.
  if (!(await playerMayHave(env, found.recording))) {
    return json({ error: 'This recording is not free' }, 402);
  }
  const download = new URL(req.url).searchParams.get('dl') === '1';
  // inline so a phone plays it in the page; the Download button forces a save.
  const res = await streamRecording(
    req,
    env,
    found.recording.object_key,
    `padel-${found.recording.id.slice(0, 8)}.mp4`,
    download ? 'attachment' : 'inline',
  );
  if (res.ok && download && isWholeFileRequest(req)) {
    ctx.waitUntil(recordEvent(env, found.recording, 'download'));
  }
  return res;
}

// ---- share page markup ----------------------------------------------------------

export const PAGE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d1218; color:#e7edf3; padding:24px;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  .card { width:100%; max-width:760px; }
  h1 { font-size:1.35rem; margin:0 0 4px; letter-spacing:-.01em; }
  p.meta { margin:0 0 20px; color:#8fa0b0; font-size:.9rem; }
  video { width:100%; border-radius:10px; background:#000; display:block; }
  a.dl { display:block; margin-top:16px; padding:16px; border-radius:10px;
         background:#2f6fd0; color:#fff; text-decoration:none; text-align:center;
         font-weight:600; font-size:1.05rem; }
  a.dl:active { background:#255ba9; }
  .note { margin-top:14px; color:#78868f; font-size:.8rem; text-align:center; }
  img.poster { width:100%; border-radius:10px; display:block; filter:brightness(.55); }
  p.locked { margin-top:16px; padding:16px; border-radius:10px; background:#1b232c;
             text-align:center; line-height:1.4; }
`;

/** The share page's document, in `lang`, with the language switch `sw` on top. */
function shareShell(lang: Lang, sw: string, title: string, body: string): string {
  return `<!doctype html><html lang="${HTML_LANG[lang]}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${PAGE_CSS}${LANG_CSS}</style></head><body>
<div class="card">${sw}
${body}
</div></body></html>`;
}

function sharePageHtml(lang: Lang, sw: string, token: string, startedAt: number, hasPoster: boolean): string {
  const t = STRINGS[lang];
  const when = new Date(startedAt).toISOString().replace('T', ' ').slice(0, 16);
  return shareShell(
    lang,
    sw,
    t.recordingTitle,
    `  <h1>${t.recordingTitle}</h1>
  <p class="meta">${t.recordedAt(when)}</p>
  <video controls playsinline preload="metadata"${
    hasPoster ? ` poster="/s/${token}/thumbnail"` : ''
  } src="/s/${token}/video"></video>
  <a class="dl" href="/s/${token}/video?dl=1" download>${t.download}</a>
  <p class="note">${t.shareExpires}</p>`,
  );
}

/**
 * A recording past its court's free period. Shows the poster so the player can
 * see it is their match -- there is no way to pay yet, so the page says so
 * plainly rather than pretending to sell something.
 */
function lockedHtml(lang: Lang, sw: string, token: string, startedAt: number, hasPoster: boolean): string {
  const t = STRINGS[lang];
  const when = new Date(startedAt).toISOString().replace('T', ' ').slice(0, 16);
  return shareShell(
    lang,
    sw,
    t.recordingTitle,
    `  <h1>${t.recordingTitle}</h1>
  <p class="meta">${t.recordedAt(when)}</p>
  ${hasPoster ? `<img class="poster" src="/s/${token}/thumbnail" alt="">` : ''}
  <p class="locked">${t.locked}</p>`,
  );
}

function expiredHtml(lang: Lang, sw: string): string {
  const t = STRINGS[lang];
  return shareShell(
    lang,
    sw,
    t.expiredTitle,
    `  <h1>${t.expiredHeading}</h1>
  <p class="meta">${t.expiredBody}</p>`,
  );
}
