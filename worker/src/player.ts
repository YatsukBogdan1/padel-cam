/**
 * The player surface: the page behind the QR sticker on the court, and the
 * private page for one match.
 *
 * The security model fits in two sentences. Scanning the court's QR code can
 * start a recording or report that the court is busy -- it never reaches
 * footage, past or present, because the sticker is on a wall where anyone can
 * photograph it. Footage is reached only through the match link, a 128-bit
 * secret handed to the phone that pressed Start and to whoever that person
 * sends it to.
 *
 * Deliberately plain server-rendered HTML, like the share page: it has to open
 * instantly on a phone at the side of the court, and nothing here needs React.
 */
import {
  addComment,
  cleanVisitId,
  clientStep,
  hasFeedback,
  isPerson,
  MAX_COMMENT,
  rate,
  track,
  trackPerson,
} from './analytics';
import { isSecureRequest, randomToken, readCookie } from './auth';
import { explicitLang, HTML_LANG, LANG_CSS, langSwitch, resolveLang, STRINGS, withLang } from './i18n';
import type { Lang, Strings } from './i18n';
import {
  getCourt,
  getCourtByQrToken,
  getLiveRecordingOnCourt,
  getMatch,
  getMatchByToken,
  getVenue,
  listSessionSegments,
  recordEvent,
} from './db';
import { PAGE_CSS } from './admin';
import { isWholeFileRequest, streamRecording, streamThumbnail } from './handlers';
import { endTimeOptions, formatLocalTime, startMatch, stopMatch } from './matches';
import type { Params } from './router';
import { isFree, isOnline } from './types';
import type { Court, Env, Match, Recording, Venue } from './types';

/** Remembers, on this phone only, which match it started at this court. */
const MATCH_COOKIE = 'padel_match';
/** Long enough to find the video again the same evening, short of the next booking day. */
const MATCH_COOKIE_MAX_AGE = 24 * 60 * 60;

// ---- language --------------------------------------------------------------------

/**
 * How one response is worded. `chosen` is the explicit `?lang=`, the only thing
 * the page's own links carry forward; without it every page re-reads the
 * browser's Accept-Language, which gives the same answer anyway.
 */
interface View {
  lang: Lang;
  chosen: Lang | null;
  t: Strings;
  /** The same page in the other language, marked so it is not counted as a visit. */
  switchTo: (to: Lang) => string;
}

function viewFor(req: Request, switchTo: (to: Lang) => string): View {
  const lang = resolveLang(req);
  return { lang, chosen: explicitLang(req), t: STRINGS[lang], switchTo };
}

/**
 * The court page's switch keeps the visit id, so scan -> switch -> Start is still
 * one visit with one scan.
 */
function courtView(req: Request, qrToken: string, visitId: string): View {
  return viewFor(req, (to) => `/c/${qrToken}?v=${visitId}&lang=${to}`);
}

/** The match page's switch is a re-render of the same page: `r=1`, like its refresh. */
function matchView(req: Request, token: string): View {
  const via = new URL(req.url).searchParams.get('via') === 'share' ? '&via=share' : '';
  return viewFor(req, (to) => `/m/${token}?r=1${via}&lang=${to}`);
}

// ---- the court page (/c/:qrToken) ------------------------------------------------

interface CourtContext {
  court: Court;
  venue: Venue;
}

async function resolveCourt(env: Env, qrToken: string): Promise<CourtContext | null> {
  const court = await getCourtByQrToken(env, qrToken);
  // An unassigned court belongs to nobody, so its sticker is dead too.
  if (!court?.venue_id) return null;
  const venue = await getVenue(env, court.venue_id);
  return venue ? { court, venue } : null;
}

/** What a phone sees after scanning the sticker. */
export async function courtPage(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  // One id per scan, carried through the start form, so "scanned" and "pressed
  // Start" join up for one phone without a cookie. Auto-refreshes (?r=1) of the
  // busy page are the same visit, not new scans -- and so is the language switch,
  // which carries the id it was issued with (?v=).
  const carried = cleanVisitId(new URL(req.url).searchParams.get('v'));
  const visitId = carried ?? randomToken(9);
  const view = courtView(req, params.qrToken!, visitId);

  const found = await resolveCourt(env, params.qrToken!);
  if (!found) return page(notActiveHtml(view), 404);
  const { court } = found;

  const scan = (detail: string) =>
    isRefresh(req) || carried
      ? undefined
      : ctx.waitUntil(trackPerson(req, env, { court_id: court.id, step: 'scan', detail, visit_id: visitId }));

  // The phone that started the match goes straight back to it. This is the only
  // way a rescan leads to footage, and it works only for the phone holding the
  // cookie -- the same secret as the link, just remembered for them.
  const mine = await myMatch(req, env, court);
  const live = await getLiveRecordingOnCourt(env, court.id);
  if (mine && live?.session_id === mine.session_id) {
    scan('returning');
    return Response.redirect(new URL(withLang(`/m/${mine.token}`, view.chosen), req.url).toString(), 303);
  }

  scan(live ? 'busy' : isOnline(court) ? 'ready' : 'offline');
  return page(await courtHtml(env, view, found, live, mine, null, visitId));
}

/** The page's own auto-refresh, which must not count as another visit. */
function isRefresh(req: Request): boolean {
  return new URL(req.url).searchParams.get('r') === '1';
}

/** The Start button. */
export async function startFromCourt(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const bookedUntil = Number(form?.get('until'));
  // Kept from the scan when it is one we issued, so a retry after an error is the
  // same visit; a fresh one otherwise, so the attempt still counts.
  const visitId = cleanVisitId(form?.get('visit')) ?? randomToken(9);
  const view = courtView(req, params.qrToken!, visitId);
  const { t } = view;

  const found = await resolveCourt(env, params.qrToken!);
  if (!found) return page(notActiveHtml(view), 404);
  const { court } = found;
  const step = (name: 'start_attempt' | 'start_failed', detail?: string) =>
    ctx.waitUntil(trackPerson(req, env, { court_id: court.id, step: name, detail, visit_id: visitId }));
  step('start_attempt');

  const rerender = async (error: string, status: number, reason: string) => {
    step('start_failed', reason);
    return page(
      await courtHtml(
        env,
        view,
        found,
        await getLiveRecordingOnCourt(env, court.id),
        await myMatch(req, env, court),
        error,
        visitId,
      ),
      status,
    );
  };

  if (form?.get('consent') !== 'yes') {
    return rerender(t.errNoConsent, 400, 'no_consent');
  }
  if (!isOnline(court)) {
    return rerender(t.errOffline, 409, 'offline');
  }

  const result = await startMatch(env, court.id, bookedUntil, 'player');
  if (!result.ok) {
    // The operator-facing message names the court id and the relay detail; a
    // player needs to know only that it did not work. A 400 is only ever the end
    // time being out of range.
    const message = result.status === 400 ? t.errInvalidTime : t.errCameraFailed;
    const reason =
      result.status === 400
        ? 'invalid_time'
        : result.error.startsWith('This court is already recording')
          ? 'busy'
          : 'camera';
    return rerender(message, result.status, reason);
  }
  ctx.waitUntil(
    track(env, {
      court_id: court.id,
      step: 'started',
      visit_id: visitId,
      session_id: result.match.session_id,
    }),
  );

  const headers = new Headers({ location: withLang(`/m/${result.match.token}`, view.chosen) });
  headers.append(
    'set-cookie',
    [
      `${MATCH_COOKIE}=${result.match.token}`,
      `Path=/c/${params.qrToken}`,
      'HttpOnly',
      ...(isSecureRequest(req) ? ['Secure'] : []),
      'SameSite=Lax',
      `Max-Age=${MATCH_COOKIE_MAX_AGE}`,
    ].join('; '),
  );
  return new Response(null, { status: 303, headers });
}

/** The match this phone started at this court, if its cookie still names one. */
async function myMatch(req: Request, env: Env, court: Court): Promise<Match | null> {
  const token = readCookie(req, MATCH_COOKIE);
  if (!token) return null;
  const match = await getMatchByToken(env, token);
  return match?.court_id === court.id ? match : null;
}

// ---- the match page (/m/:token) ---------------------------------------------------

interface MatchContext {
  match: Match;
  court: Court | null;
  venue: Venue | null;
  /** Every segment, in order. More than one only after a power cut mid-match. */
  segments: Recording[];
}

async function resolveMatch(env: Env, token: string): Promise<MatchContext | null> {
  const match = await getMatchByToken(env, token);
  if (!match) return null;
  const [court, segments] = await Promise.all([
    getCourt(env, match.court_id),
    listSessionSegments(env, match.session_id),
  ]);
  const venue = court?.venue_id ? await getVenue(env, court.venue_id) : null;
  segments.sort((a, b) => a.segment - b.segment);
  return { match, court, venue, segments };
}

/**
 * Free or locked is decided per match, by when its FIRST segment started: a
 * match that straddles the court's free-until moment because of a power cut
 * should not come back half-locked.
 */
function matchIsFree(ctx: MatchContext, rec: Recording): boolean {
  const first = ctx.segments[0] ?? rec;
  return isFree({ started_at: first.started_at, purchased: rec.purchased }, ctx.court);
}

export async function matchPage(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const view = matchView(req, params.token!);
  const found = await resolveMatch(env, params.token!);
  if (!found) return page(linkInvalidHtml(view), 404);

  // The link the starter sends out carries ?via=share, so "the group opened it"
  // is countable without knowing who anyone is.
  const via: Via = new URL(req.url).searchParams.get('via') === 'share' ? 'share' : 'direct';
  const first = found.segments[0];
  const ready = found.segments.filter((s) => s.status === 'ready');
  const settled = first && ready.length > 0 && !found.segments.some(isInFlight);
  const free = first ? matchIsFree(found, first) : true;

  if (first && !isRefresh(req) && isPerson(req)) {
    const view = found.segments.some(isInFlight)
      ? 'view_live'
      : settled
        ? free
          ? 'view_ready'
          : 'view_locked'
        : null;
    if (view) {
      ctx.waitUntil(
        track(env, { court_id: found.match.court_id, step: view, detail: via, session_id: found.match.session_id }),
      );
    }
    if (settled) ctx.waitUntil(recordEvent(env, first, free ? 'view' : 'locked_view'));
  }

  const askFeedback = settled && free ? !(await hasFeedback(env, found.match.session_id)) : false;
  return page(matchHtml(env, view, params.token!, found, via, askFeedback));
}

type Via = 'direct' | 'share';

export async function stopFromMatch(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const view = matchView(req, params.token!);
  const found = await resolveMatch(env, params.token!);
  if (!found) return page(linkInvalidHtml(view), 404);
  // Whoever holds the link may stop it -- that is how "any player on court can
  // object" works in practice. Not reported back: the camera being unreachable
  // leaves the row stopped and the sweep finishes it, so the page is correct
  // either way.
  if (found.segments.some((s) => s.status === 'recording')) {
    await track(env, {
      court_id: found.match.court_id,
      step: 'stopped',
      detail: 'manual',
      session_id: found.match.session_id,
    });
  }
  await stopMatch(env, found.match.session_id);
  return Response.redirect(new URL(withLang(`/m/${params.token}`, view.chosen), req.url).toString(), 303);
}

/**
 * The share button was tapped. Without this, a match nobody downloaded could
 * mean "did not care" or "lost the link", and those call for opposite fixes.
 */
export async function markShared(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const found = await resolveMatch(env, params.token!);
  const first = found?.segments[0];
  if (!found || !first) return new Response(null, { status: 204 });
  await recordEvent(env, first, 'share');
  // How it was shared, when the page says. An older page sends nothing: still a share.
  const how = clientStep('share', new URL(req.url).searchParams.get('how'))?.detail ?? null;
  await track(env, {
    court_id: found.match.court_id,
    step: 'share',
    detail: how,
    session_id: found.match.session_id,
  });
  return new Response(null, { status: 204 });
}

/**
 * Steps only the browser sees: the video started playing, and was watched for
 * 30 seconds. Anything not on the allowlist is dropped -- anyone holding a link
 * can post here, so it must not be able to write arbitrary rows.
 */
export async function clientEvent(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const found = await resolveMatch(env, params.token!);
  if (!found) return new Response(null, { status: 404 });
  const body = (await req.text().then(JSON.parse).catch(() => ({}))) as { step?: unknown; detail?: unknown };
  const ok = clientStep(body.step, body.detail);
  if (!ok || ok.step === 'share' || !isPerson(req)) return new Response(null, { status: 204 });
  await track(env, {
    court_id: found.match.court_id,
    step: ok.step,
    detail: ok.detail,
    session_id: found.match.session_id,
  });
  return new Response(null, { status: 204 });
}

/**
 * One tap, once per match. Only for a finished, free video: before that there is
 * nothing to judge, and asking earlier costs answers.
 */
export async function submitFeedback(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const found = await resolveMatch(env, params.token!);
  if (!found) return text('Unknown match', 404);
  const ready = found.segments.find((s) => s.status === 'ready');
  if (!ready || !matchIsFree(found, ready)) return text('Nothing to rate yet', 409);

  const body = (await req.json().catch(() => ({}))) as { rating?: unknown; comment?: unknown };
  const { session_id, court_id } = found.match;

  if (body.rating === 'up' || body.rating === 'down') {
    if (!(await rate(env, session_id, court_id, body.rating === 'up' ? 1 : -1))) {
      return text('Already rated', 409);
    }
    await track(env, { court_id, step: 'feedback', detail: body.rating, session_id });
    return new Response(null, { status: 204, headers: playerHeaders() });
  }
  if (typeof body.comment === 'string' && body.comment.trim()) {
    const saved = await addComment(env, session_id, body.comment.trim().slice(0, MAX_COMMENT));
    return saved ? new Response(null, { status: 204, headers: playerHeaders() }) : text('No rating to comment on', 409);
  }
  return text('Send rating "up" or "down", or a comment', 400);
}

export async function matchVideo(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const found = await resolveMatch(env, params.token!);
  const rec = found?.segments.find((s) => s.segment === Number(params.segment));
  if (!found || !rec?.object_key) return text('This link is no longer valid', 404);
  if (rec.status !== 'ready') return text('This recording is not ready yet', 409);
  // Enforced here, not only by hiding the player: the video path is derivable
  // from the page's own token.
  if (!matchIsFree(found, rec)) return text('This recording is not free', 402);

  const download = new URL(req.url).searchParams.get('dl') === '1';
  const res = await streamRecording(
    req,
    env,
    rec.object_key,
    `padel-${rec.id.slice(0, 8)}${found.segments.length > 1 ? `-part${rec.segment}` : ''}.mp4`,
    download ? 'attachment' : 'inline',
  );
  if (res.ok && download && isWholeFileRequest(req)) {
    ctx.waitUntil(recordEvent(env, rec, 'download'));
    ctx.waitUntil(
      trackPerson(req, env, {
        court_id: found.match.court_id,
        step: 'download',
        session_id: found.match.session_id,
      }),
    );
  }
  return res;
}

/** The poster frame -- shown even when locked, so players can see it is their match. */
export async function matchThumbnail(
  _req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const found = await resolveMatch(env, params.token!);
  const rec = found?.segments.find((s) => s.segment === Number(params.segment));
  if (!rec?.thumbnail_key) return text('No thumbnail', 404);
  return streamThumbnail(env, rec.thumbnail_key);
}

function isInFlight(rec: Recording): boolean {
  return rec.status === 'recording' || rec.status === 'uploading';
}

// ---- markup -----------------------------------------------------------------------

/**
 * Every player page. `no-referrer` because the match token is in the URL and
 * would otherwise ride along to any site the page links to; `noindex` because a
 * crawler that found one link should not publish it.
 */
export function page(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: playerHeaders({ 'content-type': 'text/html; charset=utf-8' }),
  });
}

export function playerHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    ...extra,
  });
}

function text(message: string, status: number): Response {
  return new Response(message, { status, headers: playerHeaders() });
}

const PLAYER_CSS = `
  form { margin:0; }
  .opts { display:grid; grid-template-columns:repeat(auto-fill,minmax(88px,1fr)); gap:8px; margin:12px 0 16px; }
  .opts label { display:block; }
  .opts input { position:absolute; opacity:0; }
  .opts span { display:block; padding:14px 0; text-align:center; border-radius:10px;
               background:#1b232c; font-weight:600; font-size:1.05rem; cursor:pointer; }
  .opts input:checked + span { background:#2f6fd0; color:#fff; }
  .opts input:focus-visible + span { outline:2px solid #8fb6f0; }
  .consent { display:flex; gap:10px; align-items:flex-start; margin:0 0 16px; line-height:1.4; }
  .consent input { width:22px; height:22px; flex:none; margin-top:1px; }
  button, a.btn { display:block; width:100%; margin-top:12px; padding:16px; border:0; border-radius:10px;
                  font:inherit; font-weight:600; font-size:1.05rem; text-align:center;
                  text-decoration:none; cursor:pointer; }
  .primary { background:#2f6fd0; color:#fff; }
  .wa { background:#1f8f4e; color:#fff; }
  .quiet { background:#1b232c; color:#e7edf3; }
  .danger { background:#3a1d22; color:#ffb4b4; }
  .status { padding:16px; border-radius:10px; background:#1b232c; line-height:1.45; }
  .status strong { display:block; font-size:1.15rem; margin-bottom:4px; }
  .rec-dot { display:inline-block; width:10px; height:10px; border-radius:50%; background:#e5484d;
             margin-right:8px; animation:pulse 1.6s infinite; }
  @keyframes pulse { 50% { opacity:.3; } }
  .error { padding:12px 14px; border-radius:10px; background:#3a1d22; color:#ffb4b4; margin-bottom:16px; }
  .fine { color:#78868f; font-size:.8rem; line-height:1.45; margin-top:18px; }
  .seg { margin-top:20px; }
  .seg h2 { font-size:1rem; margin:0 0 8px; color:#8fa0b0; font-weight:500; }
  .fb { margin-top:20px; padding:16px; border-radius:10px; background:#141b22; }
  .fb[hidden], .fb [hidden] { display:none; }
  .fb-q { margin:0; font-weight:600; }
  .fb-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .fb-row button { font-size:1.5rem; padding:12px; }
  .fb label { display:block; margin-bottom:8px; }
  .fb textarea { width:100%; border-radius:10px; border:1px solid #2a3540; background:#0d1218;
                 color:#e7edf3; padding:10px; font:inherit; }
  .fb-done { margin:0; color:#8fa0b0; }
`;

/**
 * `refresh` reloads `url`, which carries ?r=1 so the reload is not counted as
 * another visit -- a busy page refreshing every minute would otherwise look like
 * a queue of players.
 */
function shell(
  view: View,
  title: string,
  body: string,
  opts: { refresh?: { seconds: number; url: string } } = {},
): string {
  return `<!doctype html><html lang="${HTML_LANG[view.lang]}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
${opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh.seconds};url=${opts.refresh.url}">` : ''}
<title>${esc(title)}</title><style>${PAGE_CSS}${PLAYER_CSS}${LANG_CSS}</style></head><body>
<div class="card">${langSwitch(view.lang, view.switchTo)}${body}</div></body></html>`;
}

async function courtHtml(
  env: Env,
  view: View,
  { court, venue }: CourtContext,
  live: Recording | null,
  mine: Match | null,
  error: string | null,
  visitId: string,
): Promise<string> {
  const { t, chosen } = view;
  const heading = `<h1>${esc(court.name ?? t.defaultCourtName)}</h1>
  <p class="meta">${esc(venue.name)}</p>`;
  const myLink = mine
    ? `<a class="btn quiet" href="${withLang(`/m/${mine.token}`, chosen)}">${t.yourRecentMatch}</a>`
    : '';

  if (live) {
    const match = live.session_id ? await getMatch(env, live.session_id) : null;
    const status = match ? t.recordingUntil(formatLocalTime(match.ends_at, venue.timezone)) : t.recording;
    return shell(
      view,
      t.busyTitle,
      `${heading}
  <div class="status"><strong><span class="rec-dot"></span>${status}</strong>
  ${t.busyBody}</div>
  ${myLink}`,
      { refresh: { seconds: 60, url: withLang(`/c/${court.qr_token}?r=1`, chosen) } },
    );
  }

  if (!isOnline(court)) {
    return shell(
      view,
      t.offlineTitle,
      `${heading}
  <div class="status"><strong>${t.offlineTitle}</strong>
  ${t.offlineBody}</div>
  ${myLink}`,
    );
  }

  const options = endTimeOptions(venue);
  const retention = Number(env.RETENTION_DAYS) || 14;
  return shell(
    view,
    t.startTitle,
    `${heading}
  ${error ? `<div class="error">${esc(error)}</div>` : ''}
  <form method="post" action="${withLang(`/c/${court.qr_token}/start`, chosen)}">
    <input type="hidden" name="visit" value="${visitId}">
    <strong>${t.recordUntil}</strong>
    <div class="opts">
      ${options
        .map(
          (o) =>
            `<label><input type="radio" name="until" value="${o.at}" required><span>${o.label}</span></label>`,
        )
        .join('')}
    </div>
    <label class="consent"><input type="checkbox" name="consent" value="yes" required>
      <span>${t.consent}</span></label>
    <button class="primary" type="submit">${t.startButton}</button>
  </form>
  ${myLink}
  <p class="fine">${t.fine(esc(venue.name), retention)}</p>`,
  );
}

function matchHtml(
  env: Env,
  view: View,
  token: string,
  ctx: MatchContext,
  via: Via,
  askFeedback: boolean,
): string {
  const { t, chosen } = view;
  const again = withLang(`/m/${token}?r=1${via === 'share' ? '&via=share' : ''}`, chosen);
  const tz = ctx.venue?.timezone ?? 'UTC';
  const first = ctx.segments[0];
  const startedAt = first?.started_at ?? ctx.match.created_at;
  const title = `${esc(ctx.court?.name ?? t.defaultMatchTitle)}`;
  const heading = `<h1>${t.matchHeading}</h1>
  <p class="meta">${title}${ctx.venue ? ` · ${esc(ctx.venue.name)}` : ''} · ${t.startedAt(formatLocalTime(startedAt, tz))}</p>`;

  const recording = ctx.segments.find((s) => s.status === 'recording');
  if (recording) {
    return shell(
      view,
      t.recording,
      `${heading}
  <div class="status"><strong><span class="rec-dot"></span>${t.recordingUntil(formatLocalTime(ctx.match.ends_at, tz))}</strong>
  <span id="elapsed"></span> ${t.stopsByItself}</div>
  ${shareBlock(t, token)}
  <form method="post" action="${withLang(`/m/${token}/stop`, chosen)}"><button class="danger" type="submit">${t.stopNow}</button></form>
  <script>
    var t0=${recording.started_at}, unit=${js(t.minRecorded)};
    function tick(){var s=Math.max(0,Math.floor((Date.now()-t0)/1000));
      document.getElementById('elapsed').textContent=Math.floor(s/60)+' '+unit;}
    tick(); setInterval(tick, 15000);
  </script>`,
      { refresh: { seconds: 60, url: again } },
    );
  }

  if (ctx.segments.some((s) => s.status === 'uploading')) {
    return shell(
      view,
      t.processingTitle,
      `${heading}
  <div class="status"><strong>${t.preparing}</strong>
  ${t.processingBody}</div>
  ${shareBlock(t, token)}`,
      { refresh: { seconds: 15, url: again } },
    );
  }

  const ready = ctx.segments.filter((s) => s.status === 'ready');
  if (ready.length === 0) {
    const expired = ctx.segments.some((s) => s.status === 'expired');
    return shell(
      view,
      t.notAvailableTitle,
      `${heading}
  <div class="status"><strong>${expired ? t.deletedHeading : t.failedHeading}</strong>
  ${expired ? t.deletedBody : t.failedBody}</div>`,
    );
  }

  if (!matchIsFree(ctx, ready[0]!)) {
    return shell(
      view,
      t.matchHeading,
      `${heading}
  ${ready[0]!.thumbnail_key ? `<img class="poster" src="/m/${token}/thumbnail/${ready[0]!.segment}" alt="">` : ''}
  <p class="locked">${t.locked}</p>`,
    );
  }

  const multi = ready.length > 1;
  return shell(
    view,
    t.matchHeading,
    `${heading}
  ${multi ? `<p class="meta">${t.inParts}</p>` : ''}
  ${ready
    .map(
      (s) => `<div class="seg">${multi ? `<h2>${t.part(s.segment)}</h2>` : ''}
    <video controls playsinline preload="metadata"${
      s.thumbnail_key ? ` poster="/m/${token}/thumbnail/${s.segment}"` : ''
    } src="/m/${token}/video/${s.segment}"></video>
    <a class="btn primary" data-dl href="/m/${token}/video/${s.segment}?dl=1" download>${multi ? t.downloadPart(s.segment) : t.download}</a></div>`,
    )
    .join('')}
  ${askFeedback ? feedbackBlock(t) : ''}
  ${shareBlock(t, token)}
  ${watchScript(t, token)}
  <p class="fine">${t.availableFor(Number(env.RETENTION_DAYS) || 14)}</p>`,
  );
}

/**
 * The first thing the starter should do: get the link out of this browser.
 * Once it is in the group chat, closing the tab loses nothing. The link sent out
 * never carries `lang`: each recipient reads it in their own browser's language.
 */
function shareBlock(t: Strings, token: string): string {
  return `<a class="btn wa" id="wa" href="#">${t.shareWhatsApp}</a>
  <button class="quiet" id="share" type="button">${t.shareOrCopy}</button>
  <script>
    (function(){
      var url = location.origin + '/m/${token}?via=share';
      var msg = ${js(t.shareMessage)} + url;
      function mark(how){ try { navigator.sendBeacon('/m/${token}/shared?how=' + how); } catch(e){} }
      document.getElementById('wa').href = 'https://wa.me/?text=' + encodeURIComponent(msg);
      document.getElementById('wa').addEventListener('click', function(){ mark('whatsapp'); });
      var b = document.getElementById('share');
      b.addEventListener('click', function(){
        if (navigator.share) {
          mark('native');
          navigator.share({ title: ${js(t.shareTitle)}, url: url }).catch(function(){});
          return;
        }
        mark('copy');
        navigator.clipboard.writeText(url).then(function(){ b.textContent = ${js(t.linkCopied)}; });
      });
    })();
  </script>`;
}

/**
 * One question, revealed only once the player has pressed play or Download --
 * nobody can judge a video they have not seen. The comment box appears only after
 * the tap, and is optional.
 */
function feedbackBlock(t: Strings): string {
  return `<div id="fb" class="fb" hidden>
    <p class="fb-q">${t.fbQuestion}</p>
    <div class="fb-row">
      <button type="button" class="quiet" data-r="up" aria-label="${t.fbYes}">👍</button>
      <button type="button" class="quiet" data-r="down" aria-label="${t.fbNo}">👎</button>
    </div>
    <form id="fbc" hidden>
      <label for="fbt" id="fbl"></label>
      <textarea id="fbt" name="comment" rows="3" maxlength="${MAX_COMMENT}"></textarea>
      <button class="quiet" type="submit">${t.fbSend}</button>
    </form>
    <p id="fbd" class="fb-done" hidden>${t.fbThanks}</p>
  </div>`;
}

/** Play / watched-30s beacons, and revealing the feedback question. */
function watchScript(t: Strings, token: string): string {
  return `<script>
    (function(){
      var T = '/m/${token}';
      function beacon(step){
        try { navigator.sendBeacon(T + '/e', new Blob([JSON.stringify({ step: step })], { type: 'text/plain' })); } catch(e){}
      }
      var fb = document.getElementById('fb');
      function reveal(){ if (fb) fb.hidden = false; }
      var played = false, sent30 = false, watched = 0;
      document.querySelectorAll('video').forEach(function(v){
        var last = null;
        v.addEventListener('play', function(){ if (!played) { played = true; beacon('play'); } reveal(); last = v.currentTime; });
        v.addEventListener('seeking', function(){ last = null; });
        v.addEventListener('timeupdate', function(){
          if (v.paused) return;
          var t = v.currentTime;
          // Only real playback counts: a jump is a seek, not 30 seconds of watching.
          if (last !== null && t > last && t - last < 2) watched += t - last;
          last = t;
          if (!sent30 && watched >= 30) { sent30 = true; beacon('watch_30s'); }
        });
      });
      document.querySelectorAll('[data-dl]').forEach(function(a){ a.addEventListener('click', reveal); });
      if (!fb) return;
      function post(body){
        return fetch(T + '/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      }
      fb.querySelectorAll('[data-r]').forEach(function(btn){
        btn.addEventListener('click', function(){
          var r = btn.getAttribute('data-r');
          post({ rating: r });
          fb.querySelector('.fb-row').hidden = true;
          fb.querySelector('.fb-q').hidden = true;
          document.getElementById('fbl').textContent = r === 'up' ? ${js(t.fbImprove)} : ${js(t.fbWrong)};
          document.getElementById('fbc').hidden = false;
        });
      });
      document.getElementById('fbc').addEventListener('submit', function(e){
        e.preventDefault();
        var c = document.getElementById('fbt').value.trim();
        if (c) post({ comment: c });
        document.getElementById('fbc').hidden = true;
        document.getElementById('fbd').hidden = false;
      });
    })();
  </script>`;
}

function notActiveHtml(view: View): string {
  return shell(
    view,
    view.t.notActiveTitle,
    `<h1>${view.t.notActiveHeading}</h1>
  <p class="meta">${view.t.letClubKnow}</p>`,
  );
}

function linkInvalidHtml(view: View): string {
  return shell(
    view,
    view.t.linkInvalidTitle,
    `<h1>${view.t.linkInvalidHeading}</h1>
  <p class="meta">${view.t.linkInvalidBody}</p>`,
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A string literal safe to drop into an inline <script>. */
function js(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003c');
}
