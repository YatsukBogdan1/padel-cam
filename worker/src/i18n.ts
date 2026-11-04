/**
 * Language of the player pages (/c, /m, /s). Portugal first: pt-PT unless the
 * visitor asks for English, explicitly or through their browser.
 *
 * The choice travels in the page's own links as `?lang=` rather than in a cookie:
 * the court page already has one cookie, scoped to the court's path and holding
 * a secret, and a language preference does not need to outlive the links a phone
 * follows. A link shared to the group never carries it -- each recipient gets
 * their own browser's language.
 *
 * Every string lives in one dictionary per language, typed by `Strings`, so a
 * third language is one more object the compiler checks for completeness.
 */

export type Lang = 'pt' | 'en';

export const LANGS: readonly Lang[] = ['pt', 'en'];

/** The `<html lang>` value. pt-PT, never bare pt: the copy is European Portuguese. */
export const HTML_LANG: Record<Lang, string> = { pt: 'pt-PT', en: 'en' };

/** `?lang=pt` / `?lang=en` (also `pt-PT`, `en-GB`, ...), or null when not given. */
export function explicitLang(req: Request): Lang | null {
  return parseLang(new URL(req.url).searchParams.get('lang'));
}

function parseLang(value: string | null): Lang | null {
  const primary = value?.trim().toLowerCase().split(/[-_]/)[0];
  return primary === 'pt' || primary === 'en' ? primary : null;
}

/**
 * The rule: an explicit `?lang=` wins. Otherwise, English only when the browser's
 * Accept-Language ranks some English above every Portuguese entry (or lists
 * English and no Portuguese at all). Anything else -- no header, Portuguese
 * first, only other languages -- is pt-PT.
 */
export function resolveLang(req: Request): Lang {
  return explicitLang(req) ?? fromAcceptLanguage(req.headers.get('accept-language'));
}

export function fromAcceptLanguage(header: string | null): Lang {
  if (!header) return 'pt';
  const ranked = header
    .split(',')
    .map((part, i) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { lang: parseLang(tag), weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((e) => e.weight > 0)
    // Highest weight first; equal weights keep the order the browser sent.
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  return ranked.find((e) => e.lang !== null)?.lang ?? 'pt';
}

/** `path?…&lang=xx` when the language was chosen explicitly, else `path` unchanged. */
export function withLang(path: string, lang: Lang | null): string {
  if (!lang) return path;
  return `${path}${path.includes('?') ? '&' : '?'}lang=${lang}`;
}

/** The PT · EN switch shown at the top of every player page. */
export function langSwitch(current: Lang, hrefFor: (to: Lang) => string): string {
  const items = LANGS.map((l) =>
    l === current
      ? `<a aria-current="true" lang="${HTML_LANG[l]}">${l.toUpperCase()}</a>`
      : `<a href="${hrefFor(l).replace(/&/g, '&amp;')}" hreflang="${HTML_LANG[l]}" lang="${HTML_LANG[l]}" aria-label="${STRINGS[l].switchTo}">${l.toUpperCase()}</a>`,
  ).join('');
  return `<nav class="lang">${items}</nav>`;
}

export const LANG_CSS = `
  .lang { display:flex; justify-content:flex-end; gap:4px; margin:-12px -8px 4px 0; font-size:.85rem; }
  .lang a { display:inline-block; min-width:40px; padding:9px 8px; border-radius:8px; text-align:center;
            color:#8fa0b0; text-decoration:none; font-weight:600; letter-spacing:.04em; }
  .lang a[aria-current] { color:#e7edf3; background:#1b232c; }
`;

export interface Strings {
  /** aria-label on the switch link that leads to this language, in this language. */
  switchTo: string;

  // shared
  letClubKnow: string;

  // court page (/c)
  defaultCourtName: string;
  yourRecentMatch: string;
  recording: string;
  recordingUntil: (time: string) => string;
  busyTitle: string;
  busyBody: string;
  offlineTitle: string;
  offlineBody: string;
  startTitle: string;
  recordUntil: string;
  /** Legal wording: "Start page" checkbox. */
  consent: string;
  startButton: string;
  /** Legal wording: "Start page" fine print. */
  fine: (club: string, days: number) => string;
  /** Legal wording: server-side error. */
  errNoConsent: string;
  errOffline: string;
  errInvalidTime: string;
  errCameraFailed: string;
  notActiveTitle: string;
  notActiveHeading: string;

  // match page (/m)
  defaultMatchTitle: string;
  matchHeading: string;
  startedAt: (time: string) => string;
  stopsByItself: string;
  /** Follows a number, in the page's script: "12 min recorded." */
  minRecorded: string;
  stopNow: string;
  processingTitle: string;
  preparing: string;
  processingBody: string;
  notAvailableTitle: string;
  deletedHeading: string;
  deletedBody: string;
  failedHeading: string;
  failedBody: string;
  locked: string;
  inParts: string;
  part: (n: number) => string;
  download: string;
  downloadPart: (n: number) => string;
  availableFor: (days: number) => string;
  shareWhatsApp: string;
  shareOrCopy: string;
  shareMessage: string;
  shareTitle: string;
  linkCopied: string;
  fbQuestion: string;
  fbYes: string;
  fbNo: string;
  fbImprove: string;
  fbWrong: string;
  fbSend: string;
  fbThanks: string;
  linkInvalidTitle: string;
  linkInvalidHeading: string;
  linkInvalidBody: string;

  // share page (/s)
  recordingTitle: string;
  recordedAt: (when: string) => string;
  shareExpires: string;
  expiredTitle: string;
  expiredHeading: string;
  expiredBody: string;
}

const pt: Strings = {
  switchTo: 'Ver em português',
  letClubKnow: 'Avise o clube, por favor.',

  defaultCourtName: 'Campo de padel',
  yourRecentMatch: 'O seu jogo recente →',
  recording: 'A gravar',
  recordingUntil: (t) => `A gravar até às ${t}`,
  busyTitle: 'Campo a gravar',
  busyBody: 'Está a ser gravado o jogo de outro grupo. Pode iniciar o seu quando este terminar.',
  offlineTitle: 'Câmara sem ligação',
  offlineBody: 'A câmara deste campo não está ligada neste momento. Avise o clube, por favor.',
  startTitle: 'Gravar o seu jogo',
  recordUntil: 'Gravar até às',
  consent: 'Avisei os outros jogadores de que o jogo vai ser gravado, ninguém se opõe e todos têm 16 anos ou mais.',
  startButton: 'Iniciar gravação',
  fine: (club, days) =>
    `Só imagem, sem som, só deste campo. Pára sozinha à hora escolhida; quem tem o link pode parar antes. ` +
    `Veem o vídeo: quem tem o link, a equipa do clube e o operador do serviço. ` +
    `Apagado ${days} dias após o jogo. Responsáveis: ${club} e Padel Smart-Cam.`,
  errNoConsent: 'Confirme que avisou os outros jogadores.',
  errOffline: 'A câmara está sem ligação neste momento. Avise o clube, por favor.',
  errInvalidTime: 'Escolha uma hora de fim entre 5 minutos e 3 horas a partir de agora.',
  errCameraFailed: 'A câmara não começou a gravar. Avise o clube, por favor.',
  notActiveTitle: 'Código inativo',
  notActiveHeading: 'Este código não está ativo',

  defaultMatchTitle: 'Jogo de padel',
  matchHeading: 'O seu jogo de padel',
  startedAt: (t) => `começou às ${t}`,
  stopsByItself: 'Termina sozinha — não precisa de manter esta página aberta.',
  minRecorded: 'min gravados.',
  stopNow: 'Parar a gravação agora',
  processingTitle: 'A processar',
  preparing: 'A preparar o seu vídeo…',
  processingBody:
    'Normalmente demora menos de um minuto. Se a internet do clube estiver em baixo pode demorar mais — ' +
    'o vídeo está guardado na câmara e vai aparecer aqui.',
  notAvailableTitle: 'Indisponível',
  deletedHeading: 'Este vídeo foi apagado',
  deletedBody: 'Os vídeos são guardados durante um tempo limitado após o jogo.',
  failedHeading: 'A gravação não funcionou',
  failedBody: 'Lamentamos — a câmara não gravou este jogo. Avise o clube, por favor.',
  locked: 'As gravações gratuitas neste campo terminaram. Em breve vai ser possível comprar o vídeo do seu jogo.',
  inParts: 'A câmara ficou sem energia durante o jogo, por isso o vídeo está dividido em partes.',
  part: (n) => `Parte ${n}`,
  download: 'Transferir vídeo',
  downloadPart: (n) => `Transferir parte ${n}`,
  availableFor: (d) => `Disponível durante ${d} dias após o jogo.`,
  shareWhatsApp: 'Enviar o link ao grupo (WhatsApp)',
  shareOrCopy: 'Partilhar ou copiar o link',
  shareMessage: 'O vídeo do nosso jogo de padel: ',
  shareTitle: 'Jogo de padel',
  linkCopied: 'Link copiado',
  fbQuestion: 'Foi útil?',
  fbYes: 'Sim, foi útil',
  fbNo: 'Não foi útil',
  fbImprove: 'Há alguma coisa a melhorar? (opcional)',
  fbWrong: 'O que correu mal? (opcional)',
  fbSend: 'Enviar',
  fbThanks: 'Obrigado — ajuda-nos muito.',
  linkInvalidTitle: 'Link inválido',
  linkInvalidHeading: 'Este link não é válido',
  linkInvalidBody: 'Confirme que copiou o link completo, ou peça-o a quem iniciou a gravação.',

  recordingTitle: 'A sua gravação de padel',
  recordedAt: (w) => `Gravado em ${w} UTC`,
  shareExpires: 'Este link expira 30 dias depois de ter sido criado.',
  expiredTitle: 'Link indisponível',
  expiredHeading: 'Este link já não está disponível',
  expiredBody: 'Pode ter expirado ou sido revogado. Peça um novo ao clube.',
};

const en: Strings = {
  switchTo: 'View in English',
  letClubKnow: 'Please let the club know.',

  defaultCourtName: 'Padel court',
  yourRecentMatch: 'Your recent match →',
  recording: 'Recording',
  recordingUntil: (t) => `Recording until ${t}`,
  busyTitle: 'Court is recording',
  busyBody: "Another group's match is being recorded. You can start yours once it ends.",
  offlineTitle: 'Camera offline',
  offlineBody: 'The camera on this court is not connected right now. Please let the club know.',
  startTitle: 'Record your match',
  recordUntil: 'Record until',
  consent: "I've told the other players the match will be recorded, nobody objects, and everyone is 16 or older.",
  startButton: 'Start recording',
  fine: (club, days) =>
    `Video only, no sound, this court only. Stops by itself at the time you pick; anyone with the link can stop it sooner. ` +
    `Who can watch: people with the link, club staff and the service operator. ` +
    `Deleted ${days} days after the match. Controllers: ${club} and Padel Smart-Cam.`,
  errNoConsent: "Please confirm you've told the other players.",
  errOffline: 'The camera is offline right now. Please let the club know.',
  errInvalidTime: 'Pick an end time between 5 minutes and 3 hours from now.',
  errCameraFailed: 'The camera did not start. Please let the club know.',
  notActiveTitle: 'Not active',
  notActiveHeading: 'This code is not active',

  defaultMatchTitle: 'Padel match',
  matchHeading: 'Your padel match',
  startedAt: (t) => `started ${t}`,
  stopsByItself: 'It stops by itself — no need to keep this page open.',
  minRecorded: 'min recorded.',
  stopNow: 'Stop recording now',
  processingTitle: 'Processing',
  preparing: 'Preparing your video…',
  processingBody:
    "Usually under a minute. If the club's internet is down it can take longer — the video is safe " +
    'on the camera and will appear here.',
  notAvailableTitle: 'Not available',
  deletedHeading: 'This video has been deleted',
  deletedBody: 'Videos are kept for a limited time after the match.',
  failedHeading: 'The recording did not work',
  failedBody: "Sorry — the camera didn't capture this match. Please let the club know.",
  locked: 'Free recordings at this court have ended. Buying your match video is coming soon.',
  inParts: 'The camera lost power during the match, so the video is in parts.',
  part: (n) => `Part ${n}`,
  download: 'Download video',
  downloadPart: (n) => `Download part ${n}`,
  availableFor: (d) => `Available for ${d} days after the match.`,
  shareWhatsApp: 'Send link to your group (WhatsApp)',
  shareOrCopy: 'Share or copy link',
  shareMessage: 'Our padel match video: ',
  shareTitle: 'Padel match',
  linkCopied: 'Link copied',
  fbQuestion: 'Was this useful?',
  fbYes: 'Yes, useful',
  fbNo: 'Not useful',
  fbImprove: 'Anything to improve? (optional)',
  fbWrong: 'What went wrong? (optional)',
  fbSend: 'Send',
  fbThanks: 'Thanks — that helps.',
  linkInvalidTitle: 'Link not valid',
  linkInvalidHeading: 'This link is not valid',
  linkInvalidBody: 'Check that the whole link was copied, or ask the person who started the recording.',

  recordingTitle: 'Your padel recording',
  recordedAt: (w) => `Recorded ${w} UTC`,
  shareExpires: 'This link expires 30 days after it was created.',
  expiredTitle: 'Link not available',
  expiredHeading: 'This link is no longer available',
  expiredBody: 'It may have expired or been revoked. Ask the club for a new one.',
};

export const STRINGS: Record<Lang, Strings> = { pt, en };
