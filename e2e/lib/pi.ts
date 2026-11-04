// Driving the camera over SSH.
//
// Faults are injected on the Pi itself rather than simulated, because the point
// of this suite is to exercise the things that only go wrong on real hardware:
// a camera another process is holding, a software encoder that cannot keep up,
// an SD card, a kernel that reboots without syncing.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Shell {
  stdout: string;
  stderr: string;
  code: number;
}

export class Pi {
  constructor(
    readonly host: string,
    readonly spoolDir: string,
  ) {}

  /** Run a command on the Pi. Never throws on a non-zero exit; inspect `code`. */
  async sh(command: string, timeoutMs = 60_000): Promise<Shell> {
    try {
      const { stdout, stderr } = await exec(
        'ssh',
        ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', this.host, command],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      );
      return { stdout, stderr, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? '',
        code: typeof err.code === 'number' ? err.code : 1,
      };
    }
  }

  /** Run and fail loudly. For steps whose success the rest of a scenario assumes. */
  async must(command: string, timeoutMs = 60_000): Promise<string> {
    const r = await this.sh(command, timeoutMs);
    if (r.code !== 0) {
      throw new Error(`pi command failed (${r.code}): ${command}\n${r.stderr || r.stdout}`);
    }
    return r.stdout.trim();
  }

  async reachable(): Promise<boolean> {
    return (await this.sh('true', 15_000)).code === 0;
  }

  // ---- agent lifecycle ---------------------------------------------------------

  async agentActive(): Promise<boolean> {
    return (await this.sh('systemctl is-active --quiet padel-agent')).code === 0;
  }

  async agentVersion(): Promise<string> {
    const r = await this.sh(
      `grep -E '^AGENT_SHA=' ${this.envFile()} | head -1 | cut -d= -f2- | tr -d '"'`,
    );
    return r.stdout.trim() || '(unset)';
  }

  envFile(): string {
    return '/home/pi/padel-recording/agent/deploy/padel-agent.env';
  }

  /**
   * Kill the agent outright. `Restart=always` brings it back within seconds,
   * which is as close to a power cut as the process can experience without
   * taking the kernel down with it -- see `hardReboot` for the real thing.
   *
   * Kills systemd's MainPID *process group*, which is both halves of the problem:
   * tsx spawns a child, so killing only the wrapper leaves a live agent behind
   * that races the restarted one on the same spool -- and `pkill -f camera-agent`
   * matches the SSH session's own command line, so it kills the shell issuing it
   * and the command reports failure while having half worked.
   */
  async killAgent(): Promise<void> {
    const before = (await this.sh('systemctl show -p MainPID --value padel-agent')).stdout.trim();
    await this.sh(
      'PID=$(systemctl show -p MainPID --value padel-agent); ' +
        '[ "$PID" != "0" ] && kill -9 -- "-$PID" 2>/dev/null; ' +
        '[ "$PID" != "0" ] && kill -9 "$PID" 2>/dev/null; true',
    );

    // Wait for the pid to CHANGE, not for the process to be absent. RestartSec=3
    // means systemd usually has a replacement running before a poll for "gone"
    // ever sees a gap -- so the old check reported a perfectly good kill as a
    // failure. A different, non-zero MainPID is the real evidence that the
    // process we killed is gone and a fresh one took over.
    for (let i = 0; i < 40; i++) {
      const now = (await this.sh('systemctl show -p MainPID --value padel-agent')).stdout.trim();
      if (now !== '0' && now !== before) return;
      await sleep(500);
    }
    throw new Error(`agent did not restart (MainPID stuck at ${before})`);
  }

  /**
   * Kill the agent WITHOUT letting it drain, then keep it down.
   *
   * `systemctl stop` sends SIGTERM, which the agent handles by sealing and
   * uploading -- so on a fast link the recording completes inside the shutdown
   * window and the row reads `ready` before the operator presses stop. Correct
   * behaviour, but it erases the state a "camera went away mid-match" test needs.
   * SIGKILL first, then stop the unit within RestartSec so systemd does not
   * bring it back.
   */
  async stopAgentHard(): Promise<void> {
    await this.sh(
      'PID=$(systemctl show -p MainPID --value padel-agent); ' +
        '[ "$PID" != "0" ] && kill -9 -- "-$PID" 2>/dev/null; ' +
        '[ "$PID" != "0" ] && kill -9 "$PID" 2>/dev/null; true',
    );
    await this.sh('sudo -n systemctl stop padel-agent');
  }

  /** Stop the unit so it does NOT come back, for presence and offline tests. */
  async stopAgent(): Promise<void> {
    await this.sh('sudo -n systemctl stop padel-agent');
    await this.killAgent().catch(() => undefined);
  }

  async startAgent(): Promise<void> {
    await this.must('sudo -n systemctl start padel-agent');
  }

  async restartAgent(): Promise<void> {
    await this.must('sudo -n systemctl restart padel-agent');
  }

  /** Wait until a fresh agent process is up and has had time to dial out. */
  async waitForAgent(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.sh('pgrep -f "[c]amera-agent.ts" >/dev/null && echo up || echo down');
      if (r.stdout.includes('up')) return;
      await sleep(1000);
    }
    throw new Error('agent did not come back');
  }

  async journal(lines = 40): Promise<string> {
    return (await this.sh(`journalctl -u padel-agent -n ${lines} --no-pager`)).stdout;
  }

  // ---- spool inspection --------------------------------------------------------

  async spoolParts(): Promise<number> {
    const r = await this.sh(`find ${this.spoolDir} -name '*.bin' 2>/dev/null | wc -l`);
    return Number(r.stdout.trim()) || 0;
  }

  async spoolBytes(): Promise<number> {
    const r = await this.sh(`du -sb ${this.spoolDir} 2>/dev/null | cut -f1`);
    return Number(r.stdout.trim()) || 0;
  }

  /**
   * Read every spool manifest, one compact JSON object per line.
   *
   * Reformatting happens ON THE PI with a real JSON parser. The previous version
   * concatenated the files, stripped newlines and split on spaces -- which cannot
   * work, because `persist()` writes indented JSON, so the indentation IS spaces.
   * It failed OPEN rather than erroring: it returned whatever fragments happened
   * to be valid JSON, so a scenario asking "is this manifest marked truncated?"
   * got a confident "no" and blamed the product for a parser bug. Anything that
   * inspects state has to fail loudly or not at all.
   */
  async spoolManifests(): Promise<Record<string, unknown>[]> {
    const r = await this.sh(
      `for m in ${this.spoolDir}/*/manifest.json; do ` +
        `[ -f "$m" ] && python3 -c ` +
        `'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' "$m"; ` +
        `done 2>/dev/null`,
    );
    const out: Record<string, unknown>[] = [];
    for (const line of r.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        out.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch (e) {
        // Never swallow this: a manifest that exists but will not parse is a
        // finding, not an absence.
        throw new Error(`unparseable spool manifest: ${(e as Error).message}`);
      }
    }
    return out;
  }

  async clearSpool(): Promise<void> {
    await this.sh(`rm -rf ${this.spoolDir}/* 2>/dev/null; true`);
  }

  async freeBytes(): Promise<number> {
    const r = await this.sh(`df -k ${this.spoolDir} | tail -1 | awk '{print $4}'`);
    return (Number(r.stdout.trim()) || 0) * 1024;
  }

  // ---- fault injection ---------------------------------------------------------

  /**
   * Cut the Pi off from the Worker for `seconds`, then restore it -- restoration
   * scheduled on the Pi itself, detached, BEFORE the block goes in. If this
   * harness crashes, the laptop closes, or SSH drops, the rule still lifts.
   * Getting this wrong means a camera at a venue that is permanently firewalled
   * off from its backend.
   *
   * Only the Worker's own addresses are blocked, never all of 443: Tailscale
   * falls back to DERP relays on 443, and blocking those would take SSH with it.
   */
  async blockWorker(backend: string, seconds: number): Promise<void> {
    const host = new URL(backend).hostname;
    const ips = await this.must(
      `getent ahostsv4 ${host} | awk '{print $1}' | sort -u | head -8`,
    );
    const addrs = ips.split('\n').map((s) => s.trim()).filter(Boolean);
    if (addrs.length === 0) throw new Error(`could not resolve ${host} on the Pi`);

    // A v4-only block proves nothing if the Pi can reach Cloudflare over v6, and
    // it would fail as a *passing* test -- capture would keep uploading happily.
    // Fail loudly instead. (ip6tables is deliberately not in the sudoers grant.)
    const v6 = await this.sh(
      `curl -s -6 -m 5 -o /dev/null -w '%{http_code}' ${backend}/api/auth/me 2>/dev/null; echo`,
    );
    const v6code = v6.stdout.trim();
    if (v6code !== '' && v6code !== '000') {
      throw new Error(
        `this Pi reaches the Worker over IPv6 (HTTP ${v6code}), so blocking IPv4 alone ` +
          `would not cut it off -- the scenario would pass while testing nothing. ` +
          `Add ip6tables to the sudoers grant in e2e/setup-pi.sh and block both.`,
      );
    }

    const add = addrs.map((ip) => `sudo -n /usr/sbin/iptables -I OUTPUT -d ${ip} -j DROP`).join('; ');
    const del = addrs.map((ip) => `sudo -n /usr/sbin/iptables -D OUTPUT -d ${ip} -j DROP`).join('; ');

    // Dead man's switch first, block second.
    await this.must(
      `nohup sh -c 'sleep ${seconds + 30}; ${del}' >/dev/null 2>&1 & echo scheduled`,
    );
    await this.must(add);
  }

  /** Lift the block early, on the happy path. */
  async unblockWorker(backend: string): Promise<void> {
    const host = new URL(backend).hostname;
    const ips = await this.sh(`getent ahostsv4 ${host} | awk '{print $1}' | sort -u | head -8`);
    for (const ip of ips.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      // Loop: -I may have been applied more than once across scenarios.
      await this.sh(
        `for i in 1 2 3; do sudo -n /usr/sbin/iptables -D OUTPUT -d ${ip} -j DROP 2>/dev/null || break; done; true`,
      );
    }
  }

  /**
   * Can the Pi still reach the Worker?
   *
   * The code is captured once rather than piped through `|| echo`: curl's
   * `-w '%{http_code}'` ALREADY prints 000 when the request fails, so a fallback
   * echo appended a second one and the result was "000000" -- never equal to
   * "000", so a working firewall rule always read as "not blocked". The check
   * was wrong, not the rule.
   */
  async workerBlocked(backend: string): Promise<boolean> {
    const r = await this.sh(
      `code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' ${backend}/api/auth/me 2>/dev/null); ` +
        `echo "\${code:-000}"`,
    );
    const code = r.stdout.trim();
    return code === '' || code === '000';
  }

  /**
   * Hold the camera with a competing process, the way an `rpicam-vid` preview
   * left running after aiming it does. The camera is single-access, so capture
   * then exits immediately.
   */
  async holdCamera(seconds: number): Promise<void> {
    await this.must(
      `nohup rpicam-vid -t ${seconds * 1000} --nopreview --codec yuv420 -o /dev/null >/dev/null 2>&1 & echo held`,
    );
  }

  async releaseCamera(): Promise<void> {
    await this.sh('pkill -f "rpicam-vid -t" ; true');
  }

  /**
   * A real unclean reboot: no unmount, no sync. This is the only way to test
   * that the spool's fsync discipline actually holds -- `kill -9` leaves the
   * page cache intact, so it proves nothing about a power cut.
   */
  async hardReboot(): Promise<void> {
    // Full path: /usr/sbin is not on the Pi's non-login PATH, so a bare
    // `reboot` resolves to nothing over SSH.
    await this.sh('sudo -n /usr/sbin/reboot -f >/dev/null 2>&1 &', 10_000);
  }

  async waitForBoot(timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await sleep(10_000); // let it actually go down before we look for it
    while (Date.now() < deadline) {
      if (await this.reachable()) return;
      await sleep(3000);
    }
    throw new Error('Pi did not come back after reboot');
  }

  // ---- config ------------------------------------------------------------------

  /**
   * Snapshot the whole env file, so it can be put back byte for byte.
   *
   * This replaced returning the previous *value* from `setEnv`. That value had to
   * survive four layers of quoting -- JS template, ssh argv, remote shell, printf
   * -- and CAPTURE_CMD contains a pipe and embedded quotes. The read came back
   * empty, the caller's `if (previous)` guard silently skipped the restore,
   * nothing threw, and the Pi was left configured to record a TEST PATTERN
   * instead of the court. Copying the file avoids parsing a value nobody needs
   * to parse.
   */
  async backupEnv(): Promise<void> {
    // Never snapshot an env that already holds the synthetic source. A run
    // interrupted mid-scenario skips its cleanup, and the next run's backup used
    // to copy the test-pattern env OVER the only good backup -- losing the real
    // camera command for good. If a backup exists, it predates the swap: keep it.
    const env = this.envFile();
    const r = await this.sh(
      `if grep -q -- '${SYNTHETIC_NEEDLE}' ${env}; then ` +
        `test -f ${env}.e2e-backup && echo kept || echo missing; ` +
        `else cp ${env} ${env}.e2e-backup && echo copied; fi`,
    );
    if (r.stdout.includes('missing')) {
      throw new Error(
        `${env} is already on the synthetic source and there is no backup to restore. ` +
          `Put the real CAPTURE_CMD back by hand (see padel-agent.env.example) before running the suite.`,
      );
    }
    if (!r.stdout.includes('kept') && !r.stdout.includes('copied')) {
      throw new Error(`could not back up ${env}: ${r.stderr || r.stdout}`);
    }
  }

  /** Put the env file back exactly as `backupEnv` found it. */
  async restoreEnv(): Promise<void> {
    await this.must(
      `test -f ${this.envFile()}.e2e-backup && mv ${this.envFile()}.e2e-backup ${this.envFile()}`,
    );
  }

  /** True when the env file still holds a value the suite injected. */
  async envContains(needle: string): Promise<boolean> {
    const r = await this.sh(`grep -c -- '${needle}' ${this.envFile()} 2>/dev/null || echo 0`);
    return Number(r.stdout.trim().split('\n')[0] ?? 0) > 0;
  }

  /** Set a key in the agent env file. Pair with backupEnv/restoreEnv to undo. */
  async setEnv(key: string, value: string): Promise<void> {
    // The value reaches the remote shell inside single quotes, so it may contain
    // pipes and double quotes -- but not single quotes.
    if (value.includes("'")) {
      throw new Error(`env value for ${key} contains a single quote, which cannot be quoted safely here`);
    }
    await this.must(
      `tmp=$(mktemp) && grep -v '^${key}=' ${this.envFile()} > "$tmp" ; ` +
        `printf '%s="%s"\\n' '${key}' '${value}' >> "$tmp" && mv "$tmp" ${this.envFile()}`,
    );
  }

  async unsetEnv(key: string): Promise<void> {
    await this.must(
      `tmp=$(mktemp) && grep -v '^${key}=' ${this.envFile()} > "$tmp" && mv "$tmp" ${this.envFile()}`,
    );
  }
}

/** Marks the synthetic MOCK_CAPTURE_CMD in the agent env file. */
const SYNTHETIC_NEEDLE = 'testsrc2';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
