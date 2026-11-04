// Draining the spool to R2, through the Worker.
//
// Decoupled from capture on purpose. The old pipeline uploaded inline and paused
// the camera whenever it fell behind, so the network's worst moment was also the
// moment footage stopped existing. Here capture only ever writes to disk, and
// this loop moves what is on disk whenever the network allows -- minutes or hours
// later, across reconnects and reboots, without capture ever noticing.
//
// A part is retried until it lands or until the server says the recording is
// gone. It is never dropped: R2 will happily complete an object around a missing
// part number, producing a video that plays and is silently incomplete.

import { readFile } from 'node:fs/promises';
import { Spool } from './spool';
import type { UploadedPart } from './spool';

const PART_TIMEOUT_MS = 120_000;
const CONTROL_TIMEOUT_MS = 15_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export interface ApiConfig {
  base: string;
  token?: string | undefined;
}

/** What the Worker said about a request that failed. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
  /**
   * A 4xx that is not a timeout or a rate limit means the server has made up its
   * mind -- the row was swept, aborted or never existed -- and retrying just
   * burns the venue's uplink. Everything else is worth another go.
   */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export type UploaderOutcome =
  | { kind: 'completed'; parts: number; bytes: number }
  | { kind: 'aborted'; reason: string }
  | { kind: 'abandoned'; reason: string };

/**
 * Drains one segment. Lives as long as the segment does -- across disconnects,
 * and (via the spool on disk) across restarts of the whole agent.
 */
export class Uploader {
  private wake: (() => void) | null = null;
  private stopped = false;
  private running: Promise<UploaderOutcome> | null = null;

  constructor(
    private readonly spool: Spool,
    private readonly api: ApiConfig,
    private readonly log: (line: string) => void,
  ) {
    spool.onPartReady = () => this.poke();
  }

  /** Begin draining. Resolves when the segment reaches a terminal state. */
  start(): Promise<UploaderOutcome> {
    this.running ??= this.loop();
    return this.running;
  }

  /** Wake the loop: a new part is ready, or the link came back. */
  poke(): void {
    this.wake?.();
    this.wake = null;
  }

  stop(): void {
    this.stopped = true;
    this.poke();
  }

  private async loop(): Promise<UploaderOutcome> {
    while (!this.stopped) {
      const id = this.spool.manifest.recordingId;
      if (!id) {
        // Captured while offline and not yet registered with the server. The
        // bytes are safe on disk; there is simply nowhere to send them yet.
        await this.sleepUntilPoked(5_000);
        continue;
      }

      const ready = await this.spool.readyParts();
      if (ready.length === 0) {
        if (this.spool.manifest.sealed) return this.finish(id);
        await this.sleepUntilPoked(5_000);
        continue;
      }

      for (const n of ready) {
        if (this.stopped) break;
        const outcome = await this.sendPart(id, n);
        if (outcome) return outcome; // permanent failure; segment is over
      }
    }
    return { kind: 'abandoned', reason: 'uploader stopped' };
  }

  /** Upload one part, retrying forever unless the server rules it out. */
  private async sendPart(id: string, n: number): Promise<UploaderOutcome | null> {
    let attempt = 0;
    while (!this.stopped) {
      attempt++;
      try {
        const body = await readFile(this.spool.partFile(n));
        const part = await this.putPart(id, n, body);
        await this.spool.completePart(part.partNumber, part.etag);
        this.log(`  ↑ part ${n} (${(body.length / 1048576).toFixed(1)}MiB)`);
        return null;
      } catch (e) {
        if (e instanceof HttpError && e.permanent) {
          const reason = `server rejected part ${n}: HTTP ${e.status} ${e.message}`;
          this.log(`✗ ${reason}`);
          return { kind: 'abandoned', reason };
        }
        const wait = jitter(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS));
        // Deliberately not counted out. The bytes are on disk, so waiting costs
        // nothing but time -- and the whole point of the spool is that a venue's
        // WiFi being down for an hour is a delay, not a loss.
        this.log(`part ${n} attempt ${attempt} failed (${(e as Error).message}) — retry in ${wait}ms`);
        await this.sleepUntilPoked(wait);
      }
    }
    return null;
  }

  /** Every byte is confirmed: assemble the object, or give up honestly. */
  private async finish(id: string): Promise<UploaderOutcome> {
    const parts = this.spool.manifest.parts;

    // `parts.length === 0` is NOT sufficient. ffmpeg with `empty_moov` emits a
    // valid fragmented-MP4 header even when it received no frames at all, so a
    // camera that never started still yields one small part -- and completing it
    // hands the operator a `ready` match containing no video, with a working
    // download link. Observed on real hardware: rpicam-vid printed "failed to
    // acquire camera" and exited with status 0.
    if (parts.length === 0 || this.spool.manifest.failed) {
      const reason =
        this.spool.manifest.failed ?? this.spool.manifest.reason ?? 'capture produced no data';
      await this.postJson(`/api/recordings/${id}/abort`, { reason }).catch(() => undefined);
      await this.spool.destroy();
      return { kind: 'aborted', reason };
    }

    try {
      await this.postJson(`/api/recordings/${id}/complete`, { parts });
    } catch (e) {
      if (e instanceof HttpError && e.permanent) {
        // The row moved on without us -- swept, or aborted from the fleet page.
        // Nothing here is salvageable, and keeping it would hold the disk forever.
        const reason = `complete rejected: HTTP ${e.status} ${e.message}`;
        this.log(`✗ ${reason}`);
        await this.spool.destroy();
        return { kind: 'abandoned', reason };
      }
      throw e; // transient: the caller retries the whole segment
    }

    const bytes = parts.length * this.spool.manifest.partSize;
    await this.spool.destroy();
    this.log(`✓ ${parts.length} part(s) uploaded, link ready`);
    return { kind: 'completed', parts: parts.length, bytes };
  }

  // ---- HTTP -------------------------------------------------------------------

  private async putPart(id: string, n: number, body: Buffer): Promise<UploadedPart> {
    const res = await fetch(`${this.api.base}/api/recordings/${id}/part/${n}`, {
      method: 'PUT',
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(body.length),
        ...this.authHeader(),
      },
      body,
      signal: AbortSignal.timeout(PART_TIMEOUT_MS),
    });
    if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
    return (await res.json()) as UploadedPart;
  }

  private async postJson(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${this.api.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeader() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
    return res;
  }

  private authHeader(): Record<string, string> {
    return this.api.token ? { authorization: `Bearer ${this.api.token}` } : {};
  }

  private sleepUntilPoked(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

function jitter(ms: number): number {
  return Math.round(ms * (0.5 + Math.random()));
}
