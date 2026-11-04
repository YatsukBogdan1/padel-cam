// The runner.
//
// Scenarios are sequential and stateful by nature -- there is one camera and one
// court -- and each takes minutes, so this prints progress as it goes rather than
// going quiet and looking like a hang.
//
//   npm run e2e                       every fast scenario
//   npm run e2e -- --include-slow     plus the real power cut
//   npm run e2e -- --only happy-path
//   npm run e2e -- --list

import { Api } from './lib/api';
import { loadConfig } from './lib/config';
import { artifactDir, saveText, type Ctx, type Scenario } from './lib/harness';
import { Pi } from './lib/pi';
import { scenarios } from './scenarios/index';

const RESET = '[0m';
const DIM = '[2m';
const BOLD = '[1m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';

interface Result {
  scenario: Scenario;
  status: 'passed' | 'failed' | 'skipped';
  ms: number;
  error?: string;
  notes: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = valueOf(args, '--only');
  const includeSlow = args.includes('--include-slow');
  const skipSudo = args.includes('--no-sudo');

  if (args.includes('--list')) {
    for (const s of scenarios) {
      const tags = [s.slow ? 'slow' : null, s.needsSudo ? 'sudo' : null].filter(Boolean).join(', ');
      console.log(`  ${s.name.padEnd(20)} ~${s.estimateMin}min ${tags ? `(${tags}) ` : ''}— ${s.what}`);
    }
    return;
  }

  const config = loadConfig();
  const api = new Api(config.backend);
  const pi = new Pi(config.pi, config.spoolDir);

  console.log(`${BOLD}Padel Smart-Cam — end-to-end against real hardware${RESET}`);
  console.log(`  worker: ${config.backend}`);
  console.log(`  camera: ${config.pi} (court ${config.courtId})`);
  console.log('');

  const session = await api.login(config.adminEmail, config.adminPassword);
  if (!session.isSuperadmin) {
    console.log(`${YELLOW}  note: not a super-admin, so test recordings cannot be purged${RESET}\n`);
  }

  const selected = scenarios.filter((s) => {
    if (only) return s.name === only;
    if (s.slow && !includeSlow) return false;
    if (s.needsSudo && skipSudo) return false;
    return true;
  });
  if (selected.length === 0) {
    throw new Error(only ? `no scenario named "${only}" (try --list)` : 'nothing selected');
  }

  const totalMin = selected.reduce((n, s) => n + s.estimateMin, 0);
  console.log(`Running ${selected.length} scenario(s), roughly ${totalMin} minutes.\n`);

  const created = new Set<string>();
  const results: Result[] = [];

  for (const scenario of selected) {
    const started = Date.now();
    const notes: string[] = [];
    const cleanups: (() => Promise<void>)[] = [];
    const artifacts = await artifactDir(scenario.name);

    console.log(`${BOLD}▶ ${scenario.name}${RESET} ${DIM}— ${scenario.what}${RESET}`);

    const ctx: Ctx = {
      config,
      api,
      pi,
      artifacts,
      created,
      log: (line) => console.log(`${DIM}${line}${RESET}`),
      step: (line) => console.log(`  · ${line}`),
      note: (line) => {
        notes.push(line);
        console.log(`  ${DIM}${line}${RESET}`);
      },
      onCleanup: (fn) => cleanups.push(fn),
    };

    try {
      await scenario.run(ctx);
      results.push({ scenario, status: 'passed', ms: Date.now() - started, notes });
      console.log(`${GREEN}  ✓ passed${RESET} ${DIM}(${fmtMs(Date.now() - started)})${RESET}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ scenario, status: 'failed', ms: Date.now() - started, error: message, notes });
      console.log(`${RED}  ✗ FAILED${RESET} ${message}\n`);
      // The journal is usually the only place the real cause is written down.
      try {
        const journal = await pi.journal(120);
        await saveText(artifacts, 'agent-journal.txt', journal);
        console.log(`${DIM}  agent journal saved to ${artifacts}/agent-journal.txt${RESET}\n`);
      } catch {
        // the Pi may be the thing that is broken
      }
    } finally {
      // Reverse order, and never let a cleanup failure mask the real result.
      for (const fn of cleanups.reverse()) {
        try {
          await fn();
        } catch (e) {
          console.log(`${YELLOW}  cleanup warning: ${(e as Error).message}${RESET}`);
        }
      }
      // Stop anything this scenario left rolling. Without it a single failure
      // cascades: the camera stays busy, every later scenario's start is refused,
      // and each one fails for a reason that has nothing to do with what it
      // tests. Diagnosing the third failure in that chain is nearly impossible,
      // which makes this the difference between a suite that localises a bug and
      // one that just goes red.
      await quiesce(ctx, results[results.length - 1]);
    }
  }

  await teardown(api, pi, created, config.keepRecordings);
  report(results);
  process.exit(results.some((r) => r.status === 'failed') ? 1 : 0);
}

/**
 * Return the camera to idle between scenarios: stop any recording still running,
 * and make sure no capture process is left holding the camera.
 */
async function quiesce(ctx: Ctx, result: Result | undefined): Promise<void> {
  try {
    const live = (await ctx.api.recordings()).filter(
      (r) => r.court_id === ctx.config.courtId && r.status === 'recording',
    );
    for (const rec of live) {
      ctx.created.add(rec.id);
      console.log(`${DIM}  quiesce: stopping ${rec.id.slice(0, 8)} left running${RESET}`);
      await ctx.api.stop(rec.id).catch(() => undefined);
    }
    if (live.length > 0) {
      // Give the agent a moment to seal and start draining before the next
      // scenario asks it to record again.
      await new Promise((r) => setTimeout(r, 8000));
    }
    // The camera being free is the precondition every scenario assumes.
    const busy = await ctx.pi.sh('pgrep -x rpicam-vid >/dev/null && echo busy || echo free');
    if (busy.stdout.includes('busy')) {
      console.log(`${YELLOW}  quiesce: camera still held — releasing${RESET}`);
      await ctx.pi.sh('pkill -x rpicam-vid; true');
    }
  } catch (e) {
    console.log(`${YELLOW}  quiesce warning: ${(e as Error).message}${RESET}`);
    if (result) result.notes.push(`quiesce warning: ${(e as Error).message}`);
  }
}

/**
 * Leave production as we found it. These recordings are real rows in the real
 * bucket, and a suite that litters them is a suite nobody runs twice.
 */
async function teardown(
  api: Api,
  pi: Pi,
  created: Set<string>,
  keep: boolean,
): Promise<void> {
  if (created.size === 0) return;
  if (keep) {
    console.log(`${YELLOW}KEEP_RECORDINGS=1 — leaving ${created.size} test recording(s) in place${RESET}\n`);
    return;
  }
  console.log(`${DIM}Cleaning up ${created.size} test recording(s)…${RESET}`);
  let purged = 0;
  for (const id of created) {
    try {
      if (await api.purge(id)) purged++;
    } catch {
      // already gone, or not a super-admin
    }
  }
  await pi.clearSpool().catch(() => undefined);
  console.log(`${DIM}Purged ${purged}/${created.size}.${RESET}\n`);
}

function report(results: Result[]): void {
  console.log(`${BOLD}Summary${RESET}`);
  for (const r of results) {
    const mark =
      r.status === 'passed' ? `${GREEN}✓${RESET}` : r.status === 'failed' ? `${RED}✗${RESET}` : '·';
    console.log(`  ${mark} ${r.scenario.name.padEnd(20)} ${fmtMs(r.ms).padStart(7)}`);
    for (const note of r.notes) console.log(`      ${DIM}${note}${RESET}`);
    if (r.error) console.log(`      ${RED}${r.error.split('\n').join('\n      ')}${RESET}`);
  }
  const failed = results.filter((r) => r.status === 'failed').length;
  console.log('');
  console.log(
    failed === 0
      ? `${GREEN}${BOLD}All ${results.length} scenario(s) passed.${RESET}`
      : `${RED}${BOLD}${failed} of ${results.length} scenario(s) failed.${RESET}`,
  );
}

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

main().catch((error: unknown) => {
  console.error(`\n${RED}${BOLD}suite error:${RESET} ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
