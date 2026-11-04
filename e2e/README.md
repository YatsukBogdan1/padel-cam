# End-to-end tests against a real camera

Everything else in this repo is checked by `npm run typecheck`. That catches
nothing that actually breaks a match: a camera another process is holding, an
encoder that cannot sustain 1080p30, an SD card, a kernel that reboots without
syncing, a venue's WiFi dropping for a minute. This suite drives a real Pi with a
real camera against a real Worker and asserts on the thing the customer receives
— a downloadable file that decodes to the right amount of video.

It is a **preproduction** suite. It deliberately breaks the camera it runs
against, so it points at a home Pi, never at a paying venue.

## Setup, once per camera

```bash
cp e2e/.env.example e2e/.env      # then fill it in
npm run e2e:setup                 # scoped sudo on the Pi; prompts for its password
```

`e2e:setup` grants passwordless sudo for exactly three things — the
`padel-agent` systemctl verbs, adding and removing one `iptables OUTPUT` rule,
and `reboot -f`. Not blanket NOPASSWD: that account is reachable over Tailscale
SSH from anywhere. It is required only for the scenarios tagged `sudo`; run with
`--no-sudo` to skip them.

## Running

```bash
npm run e2e                          # every fast scenario, ~30 min
npm run e2e -- --list                # what exists and what each proves
npm run e2e -- --only network-loss   # one scenario
npm run e2e -- --include-slow        # adds the real power cut (~40 min total)
npm run e2e -- --no-sudo             # skip fault injection that needs sudo
KEEP_RECORDINGS=1 npm run e2e        # don't purge what the run created
```

`BACKEND` in `.env` decides what is under test, so the same suite runs against a
deployed Worker or against `npm run dev` on localhost.

Downloaded video, extracted frames and — on failure — the agent's journal are
written to `e2e/artifacts/<timestamp>-<scenario>/`. **Look at the frames.** No
assertion can tell a padel court from a lens cap, and a camera nobody aimed
passes every automated check in here.

## What each scenario is really testing

| Scenario | The failure it exists to catch |
|---|---|
| `preflight` | Camera, encoder, clock, disk and connectivity — and it *measures* what this board can encode in real time, which is the number that decides whether recordings come back short |
| `happy-path` | The product. Byte count matches the download, the file decodes, and its duration matches the recording window |
| `network-loss` | A 60s outage mid-match. Capture must keep running and the spool must grow; the outage must not appear as missing video |
| `agent-crash` | The process dies mid-match. Footage before the crash still arrives, and the match resumes as a second segment |
| `stop-while-down` | The operator stops while the camera is unreachable. The footage arrives **and** the camera does not come back recording an empty court |
| `disk-budget` | The buffer fills. Seal cleanly with a valid short file; never fill the filesystem, because a full root partition takes journald and sshd with it |
| `camera-contention` | Something else holds the camera. Must fail visibly with a reason an operator can act on, not "no data" |
| `presence` | A silent camera reads offline on its own, and start refuses rather than showing a recording light for nothing |
| `qr-match` | The product as players use it: sticker → Start → link → stop from the phone → download through the link. A second phone sees only "busy", never the link; a rescan from the same phone returns to the match; the readout counts it |
| `qr-auto-stop` | Nobody presses stop. The match must end at the chosen time on its own (the court's alarm, not the 5-minute cron backstop), or the next group is filmed |
| `qr-free-period` | Past the free period the link shows the match but the video itself is refused (402). Restores the court's previous free-until afterwards |
| `hard-reboot` | `reboot -f` — no sync, no unmount. The only honest test of the spool's fsync discipline; `kill -9` leaves the page cache intact and would pass even if fsync were missing |

## Network speed

**Run the Pi on a wired connection if you can.** No scenario tests throughput --
network *loss* is simulated with `iptables`, not by a slow uplink -- so upload
speed is pure waiting cost, not signal. On a slow home uplink the suite spends
minutes shipping bytes that prove nothing.

`disk-budget` is the only one that needs inflow to beat outflow, and it blocks
the network entirely while filling, so a fast link cannot break it. The synthetic
feed is ~15 MiB/s (~120 Mbit/s), above any realistic home upstream in any case.

**Not yet built:** a dedicated slow-network scenario using `tc netem` on the Pi to
shape bandwidth to a chosen rate. That is the right way to test degraded links --
deliberately, in one place, at a reproducible rate -- rather than inheriting
"whatever the WiFi was doing" across every scenario.

## Notes

- Scenarios are **sequential and stateful** — there is one camera and one court.
  They cannot be parallelised.
- Every recording created is purged at the end. These are real rows in the real
  bucket, and a suite that litters them is one nobody runs twice.
- `MIN_DURATION_RATIO` is the coverage floor. A Pi 5 has no hardware H.264
  encoder, so 1080p30 is a software encode that may not sustain real time —
  frames are then dropped silently. Set this from what `preflight` measures on
  the actual board rather than from what you would like to be true.
- The network-loss block resolves the Worker's addresses and drops only those,
  never all of port 443: Tailscale falls back to DERP relays on 443, and blocking
  those would take SSH down with it. Restoration is scheduled on the Pi *before*
  the block goes in, so the rule lifts even if this process dies.
