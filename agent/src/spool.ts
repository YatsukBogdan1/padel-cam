// The spool: captured bytes on their way to R2, held on the Pi's disk.
//
// Video used to live only in RAM between capture and upload, which made a slow
// network *lose* footage rather than defer it: once MAX_PENDING_PARTS accumulated
// the agent paused the capture pipe, ffmpeg blocked on write, and rpicam stalled.
// At ~10 Mbit/s that buffer was about 32 seconds of slack. Beyond it the frames
// were simply gone, and the recording's media clock silently diverged from the
// wall clock.
//
// Everything now goes to disk first and is drained from there, online or offline,
// so there is ONE code path rather than a rarely-exercised fallback that rots
// until the night it is needed. It is also what makes a crash survivable: the
// spool is the recovery state, so a restart costs seconds of video instead of
// the whole match.
//
// Two R2 rules shape the layout, and both fail late and confusingly if ignored:
// every part except the last must be exactly the same size, and that is enforced
// at `complete` time -- hours after the offending part was accepted. So bytes are
// written straight into fixed-size part files and a part is only ever published
// at an exact boundary. The trailing partial file is the last part, and nothing
// else may be short.

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Flush to the platter every this many bytes: bounds what a power cut costs. */
const FSYNC_INTERVAL_BYTES = 4 * 1024 * 1024;
/** Pause capture if the disk writer falls this far behind. Should never happen. */
const MAX_WRITE_QUEUE_BYTES = 32 * 1024 * 1024;

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/**
 * The durable record of one segment. Rewritten via tmp-file + rename on every
 * change, so a power cut can never leave a half-written manifest -- the file is
 * either the old one or the new one.
 */
export interface Manifest {
  /** Directory name. Stable across a server-side id being assigned later. */
  localId: string;
  /** Server-side recording id. NULL for a segment captured while offline. */
  recordingId: string | null;
  sessionId: string | null;
  segment: number;
  courtId: string;
  /** Agent wall clock, which may be wrong before NTP syncs. Server restamps. */
  startedAt: number;
  partSize: number;
  /** Number of the part file currently being written. */
  nextPart: number;
  /** Parts R2 has confirmed. */
  parts: UploadedPart[];
  /** Capture has finished; no more bytes are coming. */
  sealed: boolean;
  /** Why it sealed, when that is worth reporting. */
  reason: string | null;
  /** Sealed early because the disk budget ran out. */
  truncated: boolean;
  /** Total bytes capture actually produced, across every part. */
  capturedBytes: number;
  /**
   * Set when the segment must be aborted rather than completed. An empty
   * capture still produces a valid fragmented-MP4 header, so "some parts exist"
   * is not evidence that any video does.
   */
  failed: string | null;
}

export interface SpoolOptions {
  root: string;
  courtId: string;
  partSize: number;
  recordingId?: string | null;
  sessionId?: string | null;
  segment?: number;
  /** Fraction of free disk this recording may consume. */
  budgetFraction: number;
}

/** Raised when the disk budget is exhausted and capture must stop. */
export class DiskBudgetExceeded extends Error {}

export class Spool {
  readonly dir: string;
  manifest: Manifest;

  private partSize: number;
  private handle: FileHandle | null = null;
  private tmpBytes = 0;
  private sinceSync = 0;
  private queue: Buffer[] = [];
  private queueBytes = 0;
  private draining = false;
  /**
   * Serialises everything that touches part files. `seal()` and the write path
   * both rename `NNNNNN.bin.tmp` to `NNNNNN.bin`, and without this they can
   * interleave across their internal awaits: seal closes the handle, the drain
   * publishes the same part, and seal's rename then fails with ENOENT. The seal
   * never completes, the manifest is never marked sealed, `complete` is never
   * called, and the recording hangs in `uploading` until the sweep kills it.
   *
   * Only observed once uploads got fast enough to keep pace with capture -- on a
   * slow uplink the drain lagged so far behind that the two never overlapped.
   */
  private lock: Promise<void> = Promise.resolve();

  /** Set when a disk write failed; this segment stores nothing more after it. */
  writeFailure: string | null = null;

  /** Bytes this recording may hold on disk before it must stop capturing. */
  budgetBytes = Number.POSITIVE_INFINITY;
  /** Bytes currently on disk for this segment, uploaded or not. */
  private diskBytes = 0;
  private warnedAt80 = false;
  private exceededFired = false;

  private constructor(dir: string, manifest: Manifest) {
    this.dir = dir;
    this.manifest = manifest;
    this.partSize = manifest.partSize;
  }

  // ---- lifecycle --------------------------------------------------------------

  /** Create a fresh segment directory and open its first part file. */
  static async create(opts: SpoolOptions): Promise<Spool> {
    const localId = opts.recordingId ?? randomUUID();
    const dir = join(opts.root, localId);
    await mkdir(join(dir, 'parts'), { recursive: true });

    const manifest: Manifest = {
      localId,
      recordingId: opts.recordingId ?? null,
      sessionId: opts.sessionId ?? null,
      segment: opts.segment ?? 1,
      courtId: opts.courtId,
      startedAt: Date.now(),
      partSize: opts.partSize,
      nextPart: 1,
      parts: [],
      sealed: false,
      reason: null,
      truncated: false,
      capturedBytes: 0,
      failed: null,
    };

    const spool = new Spool(dir, manifest);
    await spool.persist();
    await spool.openPart();
    spool.budgetBytes = await budgetFor(dir, opts.budgetFraction);
    return spool;
  }

  /**
   * Reopen every segment left on disk by a previous run. This is the whole of
   * crash and power-cut recovery: whatever was captured before the lights went
   * out is still here, and the caller decides with the server what to do with it.
   */
  static async discover(root: string): Promise<Spool[]> {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return []; // no spool yet
    }

    const found: Spool[] = [];
    for (const name of names) {
      const dir = join(root, name);
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
        const spool = new Spool(dir, manifest);
        // A part file still open when the power went is the segment's tail. It
        // can be short, which is legal only for a LAST part -- and it is one,
        // because capture cannot resume into a stream that already has an
        // ftyp+moov of its own. A new segment starts instead.
        await spool.adoptInterruptedPart();
        await spool.measure();
        found.push(spool);
      } catch {
        // Unreadable manifest: nothing here is recoverable, and leaving it costs
        // disk forever.
        await rm(dir, { recursive: true, force: true });
      }
    }
    return found;
  }

  // ---- writing ----------------------------------------------------------------

  /**
   * Accept captured bytes. Returns false when the disk writer is behind and the
   * caller should pause capture -- legitimate backpressure, unlike the network
   * kind this replaced: the disk is orders of magnitude faster than the camera,
   * so in practice this never trips.
   */
  write(chunk: Buffer): boolean {
    if (this.manifest.sealed) return true;
    this.queue.push(chunk);
    this.queueBytes += chunk.length;
    void this.drain();
    return this.queueBytes < MAX_WRITE_QUEUE_BYTES;
  }

  /** Resolves once every accepted byte is on disk. */
  async flush(): Promise<void> {
    await this.drain();
    // Wait behind anything already holding the lock, so callers can rely on
    // every accepted byte being on disk when this resolves.
    await this.withLock(async () => {
      if (this.handle) await this.handle.sync();
    });
  }

  /** Run `fn` with exclusive access to the part files. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    // Never let one failure poison the chain for everything after it.
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.withLock(async () => {
        while (this.queue.length > 0) {
          // A seal may have won the lock first; anything still queued belongs to
          // a segment that is already finished.
          if (this.manifest.sealed) break;
          const chunk = this.queue.shift()!;
          this.queueBytes -= chunk.length;
          await this.writeChunk(chunk);
        }
      });
    } catch (e) {
      // A write failure is not survivable for this segment; surface it rather
      // than silently capturing into nowhere. Recorded before sealing, because the
      // seal can fail the same way and leave the segment unsealed but no longer
      // storing anything -- the capture has to learn about it either way.
      this.manifest.reason = `spool write failed: ${(e as Error).message}`;
      this.writeFailure = this.manifest.reason;
      await this.seal(this.manifest.reason).catch(() => undefined);
    } finally {
      this.draining = false;
    }
  }

  private async writeChunk(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.handle) await this.openPart();
      // Never write past a part boundary: an over-long part is as illegal as a
      // short one, and R2 only says so at complete time.
      const room = this.partSize - this.tmpBytes;
      const take = Math.min(room, chunk.length - offset);
      await this.handle!.write(chunk, offset, take);
      this.tmpBytes += take;
      this.sinceSync += take;
      this.diskBytes += take;
      this.manifest.capturedBytes += take;
      offset += take;

      if (this.tmpBytes >= this.partSize) {
        await this.publishPart();
      } else if (this.sinceSync >= FSYNC_INTERVAL_BYTES) {
        await this.handle!.sync();
        this.sinceSync = 0;
      }
    }
    this.enforceBudget();
  }

  private enforceBudget(): void {
    if (!Number.isFinite(this.budgetBytes)) return;
    if (!this.warnedAt80 && this.diskBytes > this.budgetBytes * 0.8) {
      this.warnedAt80 = true;
      this.onBudgetWarning?.(this.diskBytes / this.budgetBytes);
    }
    // Once only. enforceBudget runs after every chunk, and capture keeps writing
    // while the child flushes and dies, so an unguarded callback fired 559 times
    // in one second -- pointless work and a burst of SD-card writes at exactly
    // the moment the disk is the resource under pressure.
    if (!this.exceededFired && this.diskBytes > this.budgetBytes * 0.95) {
      this.exceededFired = true;
      // Stop cleanly rather than filling the filesystem. A full root partition
      // takes journald and sshd down with it, turning a network outage into a
      // venue visit -- and dropping older parts instead would leave a hole in
      // the middle of the video, which for MP4 means a broken file. A short,
      // valid recording is the only good answer.
      this.onBudgetExceeded?.();
    }
  }

  /** Called once when the spool passes 80% of its disk budget. */
  onBudgetWarning: ((used: number) => void) | null = null;
  /** Called when the spool passes 95%: capture must stop. */
  onBudgetExceeded: (() => void) | null = null;

  // ---- part files -------------------------------------------------------------

  private partPath(n: number, tmp: boolean): string {
    return join(this.dir, 'parts', `${String(n).padStart(6, '0')}.bin${tmp ? '.tmp' : ''}`);
  }

  private async openPart(): Promise<void> {
    this.handle = await open(this.partPath(this.manifest.nextPart, true), 'a');
    const info = await this.handle.stat();
    this.tmpBytes = info.size;
    this.sinceSync = 0;
  }

  /**
   * Seal the current part file at an exact size boundary and make it eligible
   * for upload. fsync before the rename, and fsync the directory after it, so a
   * part that appears complete after a power cut genuinely is.
   */
  private async publishPart(): Promise<void> {
    if (!this.handle) return;
    await this.handle.sync();
    await this.handle.close();
    this.handle = null;
    const n = this.manifest.nextPart;
    await rename(this.partPath(n, true), this.partPath(n, false));
    await syncDir(dirname(this.partPath(n, false)));
    this.manifest.nextPart = n + 1;
    this.tmpBytes = 0;
    this.sinceSync = 0;
    await this.persist();
    this.onPartReady?.(n);
  }

  /** Called when a part file is complete and ready to upload. */
  onPartReady: ((partNumber: number) => void) | null = null;

  /**
   * On recovery, promote a part file that was still being written into the
   * segment's final part. Legal precisely because it IS last: capture never
   * resumes into this segment.
   */
  private async adoptInterruptedPart(): Promise<void> {
    const tmp = this.partPath(this.manifest.nextPart, true);
    try {
      const info = await stat(tmp);
      if (info.size === 0) {
        await rm(tmp, { force: true });
      } else {
        await rename(tmp, this.partPath(this.manifest.nextPart, false));
        await syncDir(join(this.dir, 'parts'));
        this.manifest.nextPart += 1;
      }
    } catch {
      // No partial part; the segment ended on a clean boundary.
    }
    this.manifest.sealed = true;
    this.manifest.reason ??= 'recovered after an unclean shutdown';
    await this.persist();
  }

  // ---- draining ---------------------------------------------------------------

  /** Part numbers written and awaiting upload, lowest first. */
  async readyParts(): Promise<number[]> {
    const uploaded = new Set(this.manifest.parts.map((p) => p.partNumber));
    let names: string[];
    try {
      names = await readdir(join(this.dir, 'parts'));
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.bin'))
      .map((n) => Number(n.replace('.bin', '')))
      .filter((n) => Number.isInteger(n) && !uploaded.has(n))
      .sort((a, b) => a - b);
  }

  partFile(n: number): string {
    return this.partPath(n, false);
  }

  /** Record a part R2 has confirmed, and reclaim its disk. */
  async completePart(partNumber: number, etag: string): Promise<void> {
    if (!this.manifest.parts.some((p) => p.partNumber === partNumber)) {
      this.manifest.parts.push({ partNumber, etag });
      this.manifest.parts.sort((a, b) => a.partNumber - b.partNumber);
    } else {
      // A retry after a timeout that actually succeeded: R2 replaced the part
      // and handed back a new etag, and the newest is the one that counts.
      const existing = this.manifest.parts.find((p) => p.partNumber === partNumber)!;
      existing.etag = etag;
    }
    await this.persist();
    const path = this.partPath(partNumber, false);
    try {
      const info = await stat(path);
      this.diskBytes = Math.max(0, this.diskBytes - info.size);
    } catch {
      // already gone
    }
    await rm(path, { force: true });
  }

  /** True when every captured byte has been confirmed by R2. */
  async fullyDrained(): Promise<boolean> {
    return this.manifest.sealed && (await this.readyParts()).length === 0;
  }

  /** Bytes still waiting to be uploaded. */
  async pendingBytes(): Promise<number> {
    let total = 0;
    for (const n of await this.readyParts()) {
      try {
        total += (await stat(this.partPath(n, false))).size;
      } catch {
        // raced with a completion
      }
    }
    return total;
  }

  // ---- state ------------------------------------------------------------------

  /** Stop accepting bytes and flush what is held. */
  async seal(reason: string | null, truncated = false): Promise<void> {
    if (this.manifest.sealed) return;
    await this.withLock(async () => {
      if (this.manifest.sealed) return;

      // Drain inline rather than calling flush(): flush() goes through drain(),
      // which wants this same lock.
      while (this.queue.length > 0) {
        const chunk = this.queue.shift()!;
        this.queueBytes -= chunk.length;
        await this.writeChunk(chunk);
      }

      if (this.handle) {
        await this.handle.sync();
        await this.handle.close();
        this.handle = null;
        if (this.tmpBytes > 0) {
          // The trailing partial file is the segment's last part, and only a last
          // part may be shorter than partSize.
          const n = this.manifest.nextPart;
          try {
            await rename(this.partPath(n, true), this.partPath(n, false));
            await syncDir(join(this.dir, 'parts'));
            this.manifest.nextPart = n + 1;
            this.onPartReady?.(n);
          } catch (e) {
            // The part was already published by the write path. Losing this race
            // must never stop the seal: an unsealed manifest means `complete` is
            // never called and the recording hangs in `uploading` forever, which
            // is far worse than one part being published twice as the same file.
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        } else {
          await rm(this.partPath(this.manifest.nextPart, true), { force: true });
        }
      }

      this.manifest.sealed = true;
      this.manifest.reason = reason;
      // A latch, never an assignment. `stopCapture` sets this flag on the
      // manifest and the capture child's `close` handler seals moments later, so
      // whether the flag was set before seal read it came down to timing -- the
      // disk-budget scenario failed, then passed, on identical code. Truncation
      // is a fact about the recording; once true it cannot become false.
      this.manifest.truncated = truncated || this.manifest.truncated;
      await this.persist();
    });
  }

  /** Mark the segment unsalvageable, so the uploader aborts instead of completing. */
  async markFailed(reason: string): Promise<void> {
    this.manifest.failed = reason;
    await this.persist();
  }

  /** Attach a server-side identity to a segment captured while offline. */
  async adopt(recordingId: string, sessionId: string | null, segment: number): Promise<void> {
    this.manifest.recordingId = recordingId;
    this.manifest.sessionId = sessionId;
    this.manifest.segment = segment;
    await this.persist();
  }

  /** Remove the segment from disk entirely. */
  async destroy(): Promise<void> {
    if (this.handle) {
      await this.handle.close().catch(() => undefined);
      this.handle = null;
    }
    await rm(this.dir, { recursive: true, force: true });
  }

  /**
   * Write the manifest durably, one write at a time.
   *
   * The write path (`publishPart`) and the uploader (`completePart`) both persist,
   * and they share one tmp file. Unserialised, they interleave across the awaits:
   * both write `manifest.json.tmp`, the first renames it away, and the second
   * rename fails with ENOENT. When the loser was the write path, `drain()` sealed
   * the segment mid-match -- the upload completed as `ready` with the rest of the
   * match missing, and the still-running capture held the camera, so every later
   * start was refused. Only seen once uploads kept pace with capture.
   *
   * This cannot use `withLock`: `publishPart` and `seal` persist while already
   * holding it. The manifest is serialised when the write RUNS, not when it was
   * requested, so the last write on disk always reflects the newest state.
   */
  private persist(): Promise<void> {
    const run = this.persisting.then(
      () => this.writeManifest(),
      () => this.writeManifest(),
    );
    this.persisting = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private persisting: Promise<void> = Promise.resolve();

  /** tmp file, fsync, rename -- so a power cut leaves the old manifest or the new one. */
  private async writeManifest(): Promise<void> {
    const path = join(this.dir, 'manifest.json');
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.manifest, null, 2));
    const fh = await open(tmp, 'r');
    await fh.sync();
    await fh.close();
    await rename(tmp, path);
    await syncDir(this.dir);
  }

  /** Recompute on-disk usage after recovery. */
  private async measure(): Promise<void> {
    this.diskBytes = await this.pendingBytes();
  }
}

/** How many bytes a new recording may spool, from what the filesystem has free. */
async function budgetFor(dir: string, fraction: number): Promise<number> {
  try {
    const fs = await statfs(dir);
    return Math.floor(fs.bavail * fs.bsize * fraction);
  } catch {
    return Number.POSITIVE_INFINITY; // unknown: never block capture over it
  }
}

/**
 * fsync a directory so a rename inside it survives a power cut. Without this the
 * rename can still be in the page cache when the lights go out, and a part that
 * looked published comes back as a `.tmp`.
 */
async function syncDir(path: string): Promise<void> {
  try {
    const fh = await open(path, constants.O_RDONLY);
    await fh.sync();
    await fh.close();
  } catch {
    // Not fatal, and not supported on every filesystem.
  }
}

/** Total bytes awaiting upload across every segment on disk. */
export async function spoolPending(spools: Spool[]): Promise<{ parts: number; bytes: number }> {
  let parts = 0;
  let bytes = 0;
  for (const s of spools) {
    parts += (await s.readyParts()).length;
    bytes += await s.pendingBytes();
  }
  return { parts, bytes };
}

/** Free bytes on the filesystem holding the spool, for health reporting. */
export async function spoolFreeBytes(root: string): Promise<number | undefined> {
  try {
    await access(root, constants.F_OK);
    const fs = await statfs(root);
    return fs.bavail * fs.bsize;
  } catch {
    return undefined;
  }
}

/** Stable identity for an error, so one recurring fault is one incident. */
export function fingerprint(...parts: string[]): string {
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 16);
}
