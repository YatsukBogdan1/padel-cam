// Padel Smart-Cam — camera agent (TypeScript).
//
// Runs on the Raspberry Pi at the court. The connection model: the agent dials OUT
// over WebSocket to the Worker and waits for start/stop commands, so the cloud can
// drive a Pi behind the venue's NAT with no inbound ports.
//
// Capture is configured via CAPTURE_CMD — a shell command that must emit a STREAMABLE
// (fragmented) MP4 to stdout (see padel-agent.env.example for per-hardware commands).
// With CAPTURE_CMD unset, a byte-generating mock runs so local dev needs no camera.
//
// Capture writes to the on-disk spool and NOTHING else; a separate uploader moves
// the spool to R2 whenever the network allows. That separation is the point: the
// camera never stops because the network is slow, gone, or because the Pi rebooted
// mid-match. See src/spool.ts for why the layout is shaped the way it is.

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { Spool, spoolFreeBytes, spoolPending } from './src/spool';
import { Uploader } from './src/uploader';

const execFileAsync = promisify(execFile);

const COURT_ID = process.env.COURT_ID ?? 'court-1';
const BASE = process.env.BACKEND ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.DEVICE_TOKEN; // must match the Worker's DEVICE_TOKEN secret
const CAPTURE_CMD = process.env.CAPTURE_CMD; // real capture when set, else mock
const PART_SIZE = (Number(process.env.PART_SIZE_MB) || 5) * 1024 * 1024;
const SPOOL_DIR = process.env.SPOOL_DIR ?? '/var/lib/padel-agent/spool';
/** Share of free disk one recording may consume before it is sealed. */
const DISK_BUDGET = (Number(process.env.DISK_BUDGET_PCT) || 80) / 100;

/**
 * Reported to the Worker on connect so the fleet's running version is visible.
 * `AGENT_SHA` is written by the deploy script from the git ref it shipped; the
 * date is only a fallback, because a hand-edited constant means two Pis on
 * different code can both claim the same version.
 */
const AGENT_VERSION = process.env.AGENT_SHA ?? process.env.AGENT_VERSION ?? '2026.09.10';

const CONTROL_TIMEOUT_MS = 15_000;

// Neither end used to send keepalives, so a NAT idle-timeout or a network change
// killed the flow silently: the Pi still saw the socket ESTABLISHED, the Durable
// Object still held it, and commands were sent into a corpse. These beats both
// detect that and prevent it, by keeping the venue's NAT mapping warm.
const HEARTBEAT_MS = 30_000;
/** Two missed beats and the link is presumed dead. */
const HEARTBEAT_TIMEOUT_MS = 2.5 * HEARTBEAT_MS;
/** The heartbeat loop must tick at least this often or the agent restarts itself. */
const WATCHDOG_TIMEOUT_MS = 4 * HEARTBEAT_MS;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** Keep the tail of capture stderr, so a failure can say why in the admin UI. */
const STDERR_KEEP_LINES = 4;
/**
 * Below this, a segment holds a container header and no video.
 *
 * ffmpeg with `empty_moov` writes a valid fragmented-MP4 header even when it
 * receives no frames at all, so "a part exists" proves nothing. Observed on real
 * hardware: with the camera held by another process, rpicam-vid printed "failed
 * to acquire camera" and exited with status 0, ffmpeg emitted a few hundred
 * bytes of header, and the recording completed as `ready` with a working
 * download link to nothing.
 */
const MIN_USABLE_CAPTURE_BYTES = 64 * 1024;

const WS_URL =
  `${BASE.replace(/^http/, 'ws')}/agent?courtId=${encodeURIComponent(COURT_ID)}` +
  (TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : '');

/** A capture in progress: the child process and the spool it is filling. */
interface Capture {
  spool: Spool;
  child: ChildProcess | null;
  mockTimer: ReturnType<typeof setInterval> | null;
  stopping: boolean;
  /** Tail of the capture command's stderr, quoted back when it fails. */
  stderr: string[];
  /**
   * Lines that actually name a problem. libcamera prints several INFO lines
   * AFTER "failed to acquire camera", so a plain tail loses the one line an
   * operator needs and shows them pipeline-registration noise instead.
   */
  stderrErrors: string[];
  exit: string | null;
}

let sock: WebSocket | null = null;
let capture: Capture | null = null;
/** Every segment on disk that still has bytes to deliver, keyed by localId. */
const uploaders = new Map<string, Uploader>();
const spools = new Map<string, Spool>();
let reconnectDelay = RECONNECT_BASE_MS;

const log = (line: string): void => console.log(`[${COURT_ID}] ${line}`);

// ---- WebSocket control channel ------------------------------------------------

function connect(): void {
  const ws = new WebSocket(WS_URL);
  sock = ws;

  let beat: ReturnType<typeof setInterval> | null = null;
  let lastAck = Date.now();

  const teardown = (): void => {
    if (beat) clearInterval(beat);
    beat = null;
  };

  ws.on('open', () => {
    log(`connected to ${sanitize(WS_URL)} (v${AGENT_VERSION})`);
    reconnectDelay = RECONNECT_BASE_MS; // a good connection resets the backoff
    lastAck = Date.now();
    void sayHello(ws);
    // The link is back: every stalled upload should try again now rather than
    // waiting out its backoff.
    for (const u of uploaders.values()) u.poke();

    beat = setInterval(() => {
      lastLoopTick = Date.now(); // self-watchdog liveness
      // The Worker answers every heartbeat. Silence across two beats means the
      // flow is gone even though the kernel still calls the socket ESTABLISHED,
      // so tear it down rather than waiting for a TCP timeout that may never
      // come. terminate() skips the close handshake, which a dead link cannot
      // complete anyway.
      if (Date.now() - lastAck > HEARTBEAT_TIMEOUT_MS) {
        log(`no heartbeat ack in ${HEARTBEAT_TIMEOUT_MS}ms — reconnecting`);
        ws.terminate();
        return;
      }
      void sendHeartbeat(ws);
    }, HEARTBEAT_MS);
  });

  ws.on('message', (data: WebSocket.RawData) => {
    let msg: {
      type?: string;
      recordingId?: string;
      sessionId?: string;
      segment?: number;
      commandId?: string;
      items?: ResumeDecision[];
    };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'heartbeat-ack') {
      lastAck = Date.now();
      return;
    }
    // Any traffic at all proves the link is alive.
    lastAck = Date.now();

    if (msg.type === 'resume-plan' && msg.items) {
      void applyResumePlan(msg.items);
      return;
    }

    if (msg.type === 'start' && msg.recordingId) {
      // Refuse a start we cannot honour, rather than acknowledging it and then
      // dropping it. The ack answers "did a live agent receive this", and the
      // Worker treats that as proof the camera is recording -- so an ack for a
      // start this agent is about to ignore hands the operator a recording light
      // for footage that will never exist, opens a multipart upload nothing will
      // ever fill, and leaves a row stuck in `recording` with 0 bytes. That is
      // bug 1.2, "a dead camera reports success", in the one form the ack
      // mechanism did not already cover.
      if (capture) {
        const busy = capture.spool.manifest.recordingId ?? capture.spool.manifest.localId;
        log(`✗ start refused: already recording ${busy}`);
        ack(ws, msg.commandId, false, `camera is already recording ${busy}`);
        return;
      }
      // Whether the camera then yields frames is reported separately, via abort.
      ack(ws, msg.commandId, true);
      void startCapture(msg.recordingId, msg.sessionId ?? null, msg.segment ?? 1);
      return;
    }

    if (msg.type === 'stop' && msg.recordingId) {
      if (capture?.spool.manifest.recordingId === msg.recordingId) {
        ack(ws, msg.commandId, true);
        stopCapture('stopped by operator');
        return;
      }
      // A stop for a session we no longer hold. If its spool is still draining
      // that is fine -- sealing it is all that is needed. Otherwise the capture
      // already ended and the Worker needs telling, or the row hangs in
      // `uploading` with nothing left to call /complete.
      const spool = findSpoolByRecording(msg.recordingId);
      if (spool) {
        ack(ws, msg.commandId, true);
        void spool.seal('stopped by operator while draining');
        return;
      }
      log(`stop for unknown recording ${msg.recordingId} — aborting it`);
      ack(ws, msg.commandId, false, 'no such recording session on this camera');
      void abortRecording(
        msg.recordingId,
        'camera had no active session for this recording (capture had already ended)',
      );
    }
  });

  ws.on('close', () => {
    teardown();
    // Jittered backoff: a whole fleet reconnecting after a Worker deploy should
    // not arrive in lockstep.
    const wait = Math.round(reconnectDelay * (0.5 + Math.random()));
    log(`disconnected, retrying in ${wait}ms`);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    setTimeout(connect, wait);
  });

  ws.on('error', (e: Error) => log(`ws error: ${e.message}`));
}

/**
 * Announce ourselves, and declare every segment still held on disk.
 *
 * The declaration is what makes buffering safe. The Worker's stale sweep aborts
 * an `uploading` row after 30 minutes, or 10 minutes past a court's last
 * heartbeat -- which is exactly what a Pi buffering through an outage looks
 * like. Without this the sweep would destroy the multipart upload the returning
 * camera is about to deliver hours of footage into.
 */
async function sayHello(ws: WebSocket): Promise<void> {
  const resume = [];
  for (const spool of spools.values()) {
    resume.push({
      localId: spool.manifest.localId,
      recordingId: spool.manifest.recordingId,
      sessionId: spool.manifest.sessionId,
      segment: spool.manifest.segment,
      sealed: spool.manifest.sealed,
      pendingParts: (await spool.readyParts()).length,
      capturing: capture?.spool.manifest.localId === spool.manifest.localId,
    });
  }
  send(ws, { type: 'hello', version: AGENT_VERSION, resume });
}

async function sendHeartbeat(ws: WebSocket): Promise<void> {
  const pending = await spoolPending([...spools.values()]);
  send(ws, {
    type: 'heartbeat',
    // Renews the lease on everything still in flight, so the sweep leaves it be.
    claims: [...spools.values()]
      .map((s) => s.manifest.recordingId)
      .filter((id): id is string => id !== null),
    health: await readHealth(pending),
  });
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    log(`send failed: ${(e as Error).message}`);
  }
}

function ack(ws: WebSocket, commandId: string | undefined, ok: boolean, error?: string): void {
  if (!commandId) return;
  send(ws, { type: 'ack', commandId, ok, ...(error ? { error } : {}) });
}

function reportStatus(recordingId: string, patch: Record<string, unknown>): void {
  if (sock) send(sock, { type: 'status', recordingId, patch });
}

/**
 * Tell the Worker to give up on a recording. This is the important half: it
 * aborts the R2 multipart upload, which reporting `failed` up the WebSocket
 * never did — every abandoned recording used to leave one open, billed and
 * absent from any bucket listing.
 */
async function abortRecording(recordingId: string, reason: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/recordings/${recordingId}/abort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    log(`abort ${recordingId}: HTTP ${res.status} — ${reason}`);
  } catch (e) {
    log(`abort ${recordingId} failed: ${(e as Error).message}`);
  }
}

// ---- Recovery -----------------------------------------------------------------

interface ResumeDecision {
  localId: string;
  /**
   * 'drain' keeps delivering; 'discard' throws the segment away; 'register'
   * attaches a server row to a segment captured offline; 'stop-capture' means
   * the operator ended the match while we were unreachable.
   */
  action: 'drain' | 'discard' | 'register' | 'stop-capture';
  /** Set by 'register': the row now waiting for these bytes. */
  recordingId?: string;
  /** When set, capture resumes as the next segment of this session. */
  continueSession?: string | null;
  nextSegment?: number;
}

/**
 * Adopt whatever the last run left on disk. This is the entire power-cut story:
 * the footage captured before the lights went out is still in the spool, so the
 * job on boot is to deliver it -- and only then to ask whether the match is
 * still running.
 */
async function recoverSpools(): Promise<void> {
  const found = await Spool.discover(SPOOL_DIR);
  for (const spool of found) {
    const pending = (await spool.readyParts()).length;
    log(
      `recovered segment ${spool.manifest.localId} ` +
        `(recording ${spool.manifest.recordingId ?? 'unregistered'}, ${pending} part(s) pending)`,
    );
    track(spool);
  }
  if (found.length === 0) log('spool is empty — nothing to recover');
}

/** Register a spool and start draining it. */
function track(spool: Spool): void {
  spools.set(spool.manifest.localId, spool);
  const uploader = new Uploader(spool, { base: BASE, token: TOKEN }, log);
  uploaders.set(spool.manifest.localId, uploader);
  void uploader
    .start()
    .then((outcome) => {
      log(`segment ${spool.manifest.localId}: ${outcome.kind}`);
      uploaders.delete(spool.manifest.localId);
      spools.delete(spool.manifest.localId);
    })
    .catch((e: Error) => log(`segment ${spool.manifest.localId} drain error: ${e.message}`));
}

/**
 * Act on the server's verdict for each recovered segment.
 *
 * The local manifest is data; the server is the decision. That split is what
 * makes "the operator pressed stop while the Pi was rebooting" work correctly --
 * the camera cannot know that on its own, and guessing wrong means recording an
 * empty court for hours.
 */
async function applyResumePlan(items: ResumeDecision[]): Promise<void> {
  for (const item of items) {
    const spool = spools.get(item.localId);
    if (!spool) continue;

    if (item.action === 'stop-capture') {
      // Learned only now, on reconnect: the match is over. Without this the
      // camera would record an empty court until its disk filled.
      log(`segment ${item.localId}: the operator stopped this match while we were offline`);
      if (capture?.spool.manifest.localId === item.localId) {
        stopCapture('stopped by operator while the camera was offline');
      }
      continue;
    }

    if (item.action === 'register' && item.recordingId) {
      // Captured with no network, so it had no row until now.
      log(`segment ${item.localId}: registered as recording ${item.recordingId}`);
      await spool.adopt(item.recordingId, spool.manifest.sessionId, spool.manifest.segment);
      uploaders.get(item.localId)?.poke();
      continue;
    }

    if (item.action === 'discard') {
      log(`segment ${item.localId}: server says discard`);
      uploaders.get(item.localId)?.stop();
      uploaders.delete(item.localId);
      spools.delete(item.localId);
      await spool.destroy();
      continue;
    }

    // Sealed segments just finish draining, which they are already doing.
    uploaders.get(item.localId)?.poke();

    if (item.continueSession && !capture) {
      log(`resuming session ${item.continueSession} as segment ${item.nextSegment ?? 2}`);
      await openNextSegment(item.continueSession, item.nextSegment ?? 2);
    }
  }
}

/** Ask the Worker for a row and a fresh multipart upload for the next segment. */
async function openNextSegment(sessionId: string, segment: number): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/sessions/${sessionId}/segment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify({ courtId: COURT_ID, segment }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!res.ok) {
      log(`could not open segment ${segment}: HTTP ${res.status} ${await res.text()}`);
      return;
    }
    const rec = (await res.json()) as { id: string };
    await startCapture(rec.id, sessionId, segment);
  } catch (e) {
    log(`could not open segment ${segment}: ${(e as Error).message}`);
  }
}

// ---- Capture ------------------------------------------------------------------

async function startCapture(
  recordingId: string,
  sessionId: string | null,
  segment: number,
): Promise<void> {
  if (capture) {
    // Belt and braces: the control channel refuses a start while busy, so
    // reaching here means a second path tried to open a capture.
    log(`✗ startCapture called while already recording ${capture.spool.manifest.recordingId}`);
    return;
  }
  const mode = CAPTURE_CMD ? 'capture' : 'mock';
  log(`▶ recording ${recordingId} (${mode}, ${PART_SIZE / 1048576}MiB parts, segment ${segment})`);

  const spool = await Spool.create({
    root: SPOOL_DIR,
    courtId: COURT_ID,
    partSize: PART_SIZE,
    recordingId,
    sessionId,
    segment,
    budgetFraction: DISK_BUDGET,
  });

  const c: Capture = {
    spool,
    child: null,
    mockTimer: null,
    stopping: false,
    stderr: [],
    stderrErrors: [],
    exit: null,
  };
  capture = c;

  spool.onBudgetWarning = (used) => {
    const pct = Math.round(used * 100);
    log(`⚠ spool at ${pct}% of its disk budget`);
    reportStatus(recordingId, { warning: `Disk buffer ${pct}% full on ${COURT_ID}` });
  };
  spool.onBudgetExceeded = () => {
    // Seal rather than fill the filesystem: a full root partition takes journald
    // and sshd with it, turning a network outage into a venue visit.
    log('✗ disk budget exhausted — sealing the recording early');
    stopCapture('disk buffer full', true);
  };

  track(spool);

  if (CAPTURE_CMD) {
    // detached → own process group, so we can SIGINT the whole `rpicam | ffmpeg`
    // pipeline at once and let ffmpeg flush the trailing MP4 fragment.
    const child = spawn('sh', ['-c', CAPTURE_CMD], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    c.child = child;
    child.stdout!.on('data', (chunk: Buffer) => feed(c, chunk));
    child.stderr!.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const text = line.trim();
        if (!text) continue;
        log(`capture: ${text}`);
        // Keep the tail so a failure can quote the real cause — "failed to
        // acquire camera" when something else (an rpicam preview left running,
        // say) still holds the device — instead of only "no data captured".
        c.stderr.push(text);
        if (c.stderr.length > STDERR_KEEP_LINES) c.stderr.shift();
        if (/error|fail|unable|busy|cannot|denied|no such/i.test(text)) {
          c.stderrErrors.push(text);
          if (c.stderrErrors.length > STDERR_KEEP_LINES) c.stderrErrors.shift();
        }
      }
    });
    child.on('error', (e: Error) => {
      log(`capture spawn failed: ${e.message}`);
      c.exit = `spawn failed: ${e.message}`;
      void finishCapture(c);
    });
    // Natural exit (or exit after our SIGINT): seal and let the uploader drain.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      c.exit = signal ? `capture killed by ${signal}` : `capture exited with code ${code}`;
      log(c.exit);
      void finishCapture(c);
    });
  } else {
    // Mock: ~5 MiB/s of filler so parts flow at a realistic cadence.
    c.mockTimer = setInterval(() => feed(c, Buffer.alloc(1024 * 1024, `PADEL ${COURT_ID}\n`)), 200);
  }
}

/** Hand captured bytes to the spool, pausing the camera only if the DISK lags. */
function feed(c: Capture, chunk: Buffer): void {
  if (capture !== c) return;
  if ((c.spool.manifest.sealed || c.spool.writeFailure) && !c.stopping) {
    // The spool stopped storing under a live capture -- a disk write failed, and
    // it either sealed or wedged. Every byte from here on would be dropped, and a
    // capture left running keeps `capture` set, so the camera refuses every later
    // start until the agent restarts. End it now, and say why: the recording is
    // short, and nothing else would tell the operator.
    const cause = c.spool.writeFailure ?? c.spool.manifest.reason ?? 'unknown';
    const why = `spool stopped storing under a live capture: ${cause}`;
    log(`✗ ${why}`);
    const id = c.spool.manifest.recordingId;
    if (id) reportStatus(id, { warning: `Recording ended early: ${why}`.slice(0, 500) });
    stopCapture(why);
    return;
  }
  const ok = c.spool.write(chunk);
  if (!ok && c.child?.stdout && !c.child.stdout.isPaused()) {
    c.child.stdout.pause();
    setTimeout(() => c.child?.stdout?.resume(), 100);
  }
}

function stopCapture(reason: string, truncated = false): void {
  const c = capture;
  if (!c || c.stopping) return;
  c.stopping = true;
  c.exit ??= reason;
  log(`⏹ ${reason}`);
  if (c.child) {
    // SIGINT the whole process group so ffmpeg flushes the trailing fragment;
    // 'close' → finishCapture. SIGKILL the group as a safety net.
    signalGroup(c.child, 'SIGINT');
    setTimeout(() => signalGroup(c.child, 'SIGKILL'), 4000);
  } else {
    if (c.mockTimer) clearInterval(c.mockTimer);
    void finishCapture(c, truncated);
  }
  if (truncated) c.spool.manifest.truncated = true;
}

/**
 * Capture has ended. Seal the spool and let the uploader carry on -- draining is
 * deliberately NOT tied to this, so a crashed capture still delivers whatever it
 * managed to record, and a stop with a dead uplink finishes hours later.
 */
async function finishCapture(c: Capture, truncated = false): Promise<void> {
  if (capture === c) capture = null;
  if (c.mockTimer) clearInterval(c.mockTimer);

  const reason = [c.exit, captureDiagnosis(c)].filter(Boolean).join(' — ');
  await c.spool.seal(reason || 'capture ended', truncated || c.spool.manifest.truncated);

  // Capture ending without anyone asking it to is the precise signal that a
  // match was cut short -- the encoder died, the camera was taken away, ffmpeg
  // fell over. It is content-independent, unlike guessing from byte counts: a
  // dim or static scene compresses to almost nothing, so a perfectly good
  // recording can be a fraction of the expected size.
  const endedOnItsOwn = !c.stopping;
  if (endedOnItsOwn) {
    log(`⚠ capture ended on its own — the match was cut short: ${c.exit ?? 'unknown'}`);
  }

  // Nothing usable was captured. Fail it loudly rather than handing the operator
  // a `ready` match that plays as an empty file -- and quote the capture's own
  // stderr, which is where the real cause is ("failed to acquire camera").
  const captured = c.spool.manifest.capturedBytes;
  if (captured < MIN_USABLE_CAPTURE_BYTES) {
    const why = [
      `capture produced no usable video (${captured} bytes)`,
      c.exit,
      captureDiagnosis(c),
    ]
      .filter(Boolean)
      .join(' — ');
    log(`✗ ${why}`);
    await c.spool.markFailed(why.slice(0, 500));
  }

  const id = c.spool.manifest.recordingId;
  if (id) {
    // The Worker still believes this is `recording` when capture died on its
    // own; this is the only signal that says otherwise.
    reportStatus(id, {
      status: 'uploading',
      stopped_at: Date.now(),
      ...(c.spool.manifest.truncated
        ? { truncated: 1, warning: 'Recording sealed early: disk buffer full' }
        : endedOnItsOwn
          ? {
              warning: `Capture ended before it was stopped: ${
                [c.exit, captureDiagnosis(c)].filter(Boolean).join(' — ')
              }`.slice(0, 500),
            }
          : {}),
    });
  }
  uploaders.get(c.spool.manifest.localId)?.poke();
}

// ---- Health -------------------------------------------------------------------

/** Best-effort telemetry. Every probe here is allowed to fail silently. */
async function readHealth(pending: { parts: number; bytes: number }): Promise<
  Record<string, unknown>
> {
  const health: Record<string, unknown> = {
    pendingParts: pending.parts,
    pendingBytes: pending.bytes,
    uptimeSec: Math.round(process.uptime()),
  };
  const free = await spoolFreeBytes(SPOOL_DIR);
  if (free !== undefined) health.diskFreeBytes = free;
  if (capture && Number.isFinite(capture.spool.budgetBytes)) {
    health.diskBudgetUsed = Number((pending.bytes / capture.spool.budgetBytes).toFixed(3));
  }

  // A Pi 5 software-encoding 1080p30 in a hot court throttles, and until now that
  // was invisible until the footage came back short.
  try {
    const { stdout } = await execFileAsync('vcgencmd', ['measure_temp'], { timeout: 2_000 });
    const match = /temp=([\d.]+)/.exec(stdout);
    if (match) health.tempC = Number(match[1]);
  } catch {
    // not a Pi, or vcgencmd unavailable
  }
  try {
    const { stdout } = await execFileAsync('vcgencmd', ['get_throttled'], { timeout: 2_000 });
    const value = stdout.trim().replace('throttled=', '');
    if (value && value !== '0x0') health.throttled = value;
  } catch {
    // not a Pi
  }
  return health;
}

// ---- Helpers ------------------------------------------------------------------

/**
 * The most useful thing capture said before it died. Error lines win over the
 * plain tail: libcamera logs several INFO lines after "failed to acquire
 * camera", so quoting the tail shows an operator pipeline-registration noise
 * instead of the one sentence that tells them what to do.
 */
function captureDiagnosis(c: Capture): string | null {
  const lines = c.stderrErrors.length > 0 ? c.stderrErrors : c.stderr;
  return lines.length > 0 ? lines.join(' | ') : null;
}

function findSpoolByRecording(recordingId: string): Spool | undefined {
  for (const s of spools.values()) {
    if (s.manifest.recordingId === recordingId) return s;
  }
  return undefined;
}

function authHeader(): Record<string, string> {
  return TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
}

/** Signal the capture child's whole process group (negative pid). */
function signalGroup(child: ChildProcess | null, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
}

function sanitize(url: string): string {
  return url.replace(/token=[^&]+/, 'token=***');
}

// ---- Self-watchdog ------------------------------------------------------------

/** Advanced by the heartbeat loop. Its staleness is the liveness signal. */
let lastLoopTick = Date.now();

/**
 * Exit when the heartbeat loop has stopped advancing, so `Restart=always` can
 * recover the process.
 *
 * Deliberately NOT systemd's WatchdogSec: sd_notify needs a SOCK_DGRAM unix
 * socket, which node:dgram cannot open, leaving only a fork of `systemd-notify`
 * every 30 seconds or a native module compiled on the Pi. Neither is worth it,
 * because the authoritative detector for a wedged agent is off-machine anyway --
 * the Worker sees the heartbeats stop and alerts.
 *
 * Restarting is only safe to do casually because the spool is on disk: it costs
 * seconds of video, not the match.
 */
function startSelfWatchdog(): void {
  setInterval(() => {
    const stalled = Date.now() - lastLoopTick;
    if (stalled > WATCHDOG_TIMEOUT_MS) {
      console.error(`[${COURT_ID}] heartbeat loop stalled for ${stalled}ms — exiting to restart`);
      process.exit(1);
    }
  }, HEARTBEAT_MS).unref();
}

// ---- Crash guards -------------------------------------------------------------

/**
 * Recording is the product, so the process must outlive its own bugs. Any throw
 * from a stream callback, a timer or a stray rejection used to take the whole
 * agent down mid-match.
 *
 * Staying up is now the lesser half of the fix: because capture writes straight
 * to the spool, even a hard crash costs only the few seconds not yet fsynced.
 */
function guard(kind: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[${COURT_ID}] ${kind}: ${detail}`);
  const id = capture?.spool.manifest.recordingId;
  if (id) {
    console.error(`[${COURT_ID}] ${kind} survived — recording ${id} continues`);
    reportStatus(id, { warning: `${kind}: ${detail}`.slice(0, 500) });
  }
}

process.on('uncaughtException', (e) => guard('uncaughtException', e));
process.on('unhandledRejection', (e) => guard('unhandledRejection', e));

// SIGTERM is what systemd sends on stop/restart. Seal the capture so the spool
// is consistent; the uploader picks up where it left off after the restart.
process.on('SIGTERM', () => {
  log('SIGTERM — sealing the active recording');
  if (capture) stopCapture('agent stopped');
  setTimeout(() => process.exit(0), 5_000).unref();
});

async function main(): Promise<void> {
  await recoverSpools();
  startSelfWatchdog();
  connect();
}

void main();
