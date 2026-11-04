// Scenario plumbing: context, assertions, artifacts, and cleanup that runs even
// when a scenario throws.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Api } from './api';
import type { Config } from './config';
import { E2E_ROOT } from './config';
import { Pi } from './pi';

export interface Ctx {
  config: Config;
  api: Api;
  pi: Pi;
  /** Directory for downloaded video, extracted frames and journals. */
  artifacts: string;
  log: (line: string) => void;
  step: (line: string) => void;
  /** Recording ids the suite created, purged at the end unless KEEP_RECORDINGS=1. */
  created: Set<string>;
  /** Run after the scenario, pass or fail. Registered innermost-last. */
  onCleanup: (fn: () => Promise<void>) => void;
  /** Facts worth printing in the summary even when everything passes. */
  note: (line: string) => void;
}

export interface Scenario {
  name: string;
  /** One line: what breaking this would mean for the business. */
  what: string;
  /** Minutes this may take, so a slow scenario is not mistaken for a hang. */
  estimateMin: number;
  /** Skipped unless --include-slow (a real reboot, a long outage). */
  slow?: boolean;
  /** Needs the sudoers drop-in from `npm run e2e:setup`. */
  needsSudo?: boolean;
  run: (ctx: Ctx) => Promise<void>;
}

export class AssertionError extends Error {}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${message}\n    expected: ${String(expected)}\n    actual:   ${String(actual)}`);
  }
}

export function assertAtLeast(actual: number, min: number, message: string): void {
  if (!(actual >= min)) {
    throw new AssertionError(`${message}\n    expected: >= ${min}\n    actual:   ${actual}`);
  }
}

export function assertBetween(actual: number, lo: number, hi: number, message: string): void {
  if (!(actual >= lo && actual <= hi)) {
    throw new AssertionError(`${message}\n    expected: ${lo}..${hi}\n    actual:   ${actual}`);
  }
}

export async function artifactDir(name: string): Promise<string> {
  const dir = join(E2E_ROOT, 'artifacts', `${stamp()}-${name}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveText(dir: string, file: string, text: string): Promise<void> {
  await writeFile(join(dir, file), text);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function fmtBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Record for `seconds`, then stop -- the shape every recording scenario shares.
 * Returns the wall-clock window actually spent capturing, which is what file
 * duration gets compared against.
 */
export async function recordFor(
  ctx: Ctx,
  seconds: number,
  during?: (elapsed: number) => Promise<void>,
): Promise<{ recording: { id: string; session_id: string | null }; wallSeconds: number }> {
  const rec = await ctx.api.start(ctx.config.courtId);
  ctx.created.add(rec.id);
  ctx.step(`recording ${rec.id.slice(0, 8)} (session ${rec.session_id?.slice(0, 8) ?? 'none'})`);
  const startedAt = Date.now();

  if (during) {
    await during(0);
  } else {
    await sleep(seconds * 1000);
  }

  const wallSeconds = (Date.now() - startedAt) / 1000;
  await ctx.api.stop(rec.id);
  return { recording: rec, wallSeconds };
}
