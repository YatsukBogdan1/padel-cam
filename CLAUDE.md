# CLAUDE.md

Padel Smart-Cam: remotely start/stop a Raspberry Pi camera at a padel court from a
browser, with the video landing in Cloudflare R2 ready to download.

## Layout

```
worker/      Cloudflare Worker — HTTP API, Durable Object, D1 access, R2, cron sweeps
worker/src/super.ts        Fleet-wide operator surface (see "Two admin tiers")
worker/src/resume.ts       What a camera returning with footage is told to do
worker/src/notify.ts       Alert email, with the dedupe that keeps it un-muted
worker/src/monitor.ts      The health checks nobody can push
worker/src/incidents.ts    Production faults → the fixer
worker/scripts/            create-admin.mjs, grant-super.mjs — the only way to make accounts
worker/public/             BUILD OUTPUT of admin/ — never edit by hand
admin/       React + Vite + shadcn admin SPA; builds into worker/public
agent/       Camera agent — one Node process per Pi, dials out over WebSocket
agent/src/spool.ts         On-disk capture buffer (read this before touching capture)
agent/src/uploader.ts      Drains the spool to R2, independently of capture
agent/deploy/  systemd unit + laptop-side (setup-pi.sh) and Pi-side (provision-pi.sh) provisioning
terraform/   Cloudflare R2 bucket + D1 database only (see split below)
.github/workflows/fixer.yml  Investigates a production incident; opens a draft PR
e2e/         End-to-end suite against a real Pi and camera (see e2e/README.md)
enclosure/   OpenSCAD source, STLs and renders of the camera housing
```

npm workspaces at the root (`worker`, `agent`, `admin`). No linter. Two checks:
`npm run typecheck` (every workspace, including the worker's tests) and `npm test`
(the Worker's Vitest suite). The camera agent has no unit tests; it is covered only by
the `e2e/` suite against a real Pi.

## Commands

```bash
npm run dev                          # wrangler dev on :8787 (serves UI + API)
SPOOL_DIR=/tmp/padel-spool npm run agent   # camera agent against 127.0.0.1:8787, mock capture
npm run typecheck                    # tsc --noEmit for every workspace
npm test                             # Worker tests in workerd: D1, R2, the DO, a fake camera

cd worker && npm run migrate:local   # D1 migrations against local miniflare state
cd worker && npm run migrate:remote  # D1 migrations against the real database
cd worker && npm run deploy          # wrangler deploy (run `npm run build` first)
node worker/scripts/create-admin.mjs --venue my-club --name "My Club" --email you@x --remote
node worker/scripts/grant-super.mjs --email you@x --remote   # the ONLY way to grant super-admin
node worker/scripts/make-thumbnails.mjs                      # first-frame thumbnails (needs ffmpeg)
cd worker && npm run cf-typegen      # regenerate worker-configuration.d.ts
cd worker && npx wrangler secret put DEVICE_TOKEN
```

Local dev needs no camera and no Pi: with `CAPTURE_CMD` unset the agent generates
~5 MiB/s of filler bytes, so the whole start → parts → complete → download path
exercises for real.

## Architecture — the parts that aren't obvious

**Inverted control flow.** The Pi is behind the venue's NAT, so nothing dials *in*.
The agent opens a WebSocket to `/agent?courtId=…` and waits. `worker/src/index.ts`
routes that upgrade to `env.COURT_CAMERA.idFromName(courtId)` — one Durable Object
instance per court — which parks the socket. To command a camera, a handler does a
subrequest to the DO's internal `https://do/command`; a 409 from it means "no camera
online" and is what surfaces as the UI's offline error.

**One court is one camera.** `CourtCamera.fetch` closes any existing socket before
accepting a new one. Without that, a reconnect arriving while the old socket is still
held leaves two agents attached: `/command` broadcasts to both, both open a session for
the same `recordingId`, and both upload part N of the same multipart upload -- each
overwriting the other's etag, so `complete` fails with *"one or more of the specified
parts could not be found"* and the row hangs in `uploading`. That is a second, independent
cause of the stuck-upload symptom, distinct from the status-clobber above.

**The DO uses the hibernation API** (`this.ctx.acceptWebSocket`, `webSocketMessage`
/`webSocketClose` handlers) so an idle-but-connected camera isn't billed for
duration. Don't switch to `server.accept()` + `addEventListener` — that breaks
hibernation. Court online/offline is mirrored into D1 from the DO's connect/close
paths.

**Video streams through the Worker, not straight to R2.** `startRecording` opens the
R2 multipart upload *before* telling the camera to go, so the agent can `PUT
/api/recordings/:id/part/:n` while still recording; on stop the agent posts the
collected `{partNumber, etag}` list to `/complete`. This is why the download link is
ready seconds after stop. If the relay to the camera fails, `startRecording` aborts the
MPU and marks the row `failed` — keep that rollback intact when touching it.

**Capture writes to disk and nothing else.** `agent/src/spool.ts` holds captured bytes
on the Pi; `agent/src/uploader.ts` drains them whenever the network allows. Capture is
*never* paused for the network. Before this, video lived only in RAM and the agent
paused the capture pipe once 40 MiB accumulated — about 32 seconds of slack at
10 Mbit/s — which stalled ffmpeg and rpicam and *lost* the footage rather than
deferring it. One path, online or offline, so the offline path is exercised daily
instead of rotting until the night it is needed. It is also the crash-recovery state:
a restart now costs the few seconds not yet fsynced, not the match.

**Three R2 rules shape the spool, and each fails late and confusingly.**

- Every part except the last must be **exactly the same size**, and R2 only checks at
  `complete` — hours after the offending part was accepted. So bytes are written
  straight into fixed-size part files and a part is published only at an exact
  boundary. The trailing partial file is the last part; nothing else may be short.
  This is also why `PART_SIZE_MB` must not change mid-recording, and not go below 5.
- Incomplete multipart uploads are **auto-aborted after 7 days**, which is the hard
  ceiling on how long the spool can hold footage (`MAX_CLAIM_MS` stays under it).
- Re-uploading a part number replaces it and returns a new etag, so a retry after a
  timeout that actually succeeded is safe — the spool always records the newest etag.

**A camera holding unsent footage holds a lease.** `recordings.agent_claimed_at` is
renewed on every heartbeat while the agent still has spooled parts, and
`findStaleRecordings` honours it. This is not optional decoration: a Pi buffering
through an outage is indistinguishable from an abandoned recording by every clock the
sweep uses — same silent court, same stalled upload. Without the lease, adding the
spool would have made things *worse*, because the camera would return with hours of
video and deliver it into a multipart upload the sweep had already aborted.

**A match is a session; a power cut starts a new segment.** `recordings.session_id`
and `.segment` group the parts of one match. Capture cannot resume into the previous
segment — a second ffmpeg invocation emits its own `ftyp`+`moov`, and most players stop
dead at that boundary mid-file — so the interrupted part file becomes segment N's legal
final part and segment N+1 opens a fresh object via `POST /api/sessions/:id/segment`.

**The spool is data; the server is the decision.** A returning camera declares what it
holds in `hello`, and `resume.ts` answers per segment: `drain`, `discard`, `register`
(captured with no network, so it had no row), or `stop-capture`. That last one matters
more than it looks: if the operator ended the match while the camera was unreachable,
the stop command reached nobody and *nothing else would ever tell it* — so the camera
kept recording an empty court, and with a spool would also have kept filling its disk.
`stop_requested_at` is stamped **before** the stop is relayed precisely so a Pi that
was down can read it later.

**Status is a one-way state machine** on the `recordings` row:
`recording → uploading → ready → expired`, with `failed` as the dead end. This is
**enforced**, not merely documented: `STATUS_TRANSITIONS` in `types.ts` lists the legal
edges, and `updateRecording` turns them into a `WHERE status IN (…)` clause so the check
and the write are one statement. It returns `false` when a transition is refused.

That guard is load-bearing. Two writers race here — the HTTP handlers and the agent's
`{type:'status'}` patch arriving over the DO on a different connection — and neither
used to look at the current value. A stop would write `uploading` over a row the agent
had already marked `failed`, and since nothing but `/complete` leaves `uploading`, the
row hung there forever. Do not add an unguarded status write.

`updateRecording` also only writes columns in `RECORDING_COLUMNS` — that allowlist is
what makes it safe to feed it a patch that came off the wire. Widen it deliberately.

**Giving up on a recording goes through `abortRecording`**, never a bare status write:
an abandoned row holds an open R2 multipart upload that is billed and invisible in a
bucket listing. It aborts the MPU and records *why* in `recordings.error`, which is what
makes a field failure (something else on the Pi still holding the camera, say)
diagnosable from the browser instead of only from the Pi's journal.

**Presence is derived, never trusted.** The agent heartbeats every 30s; the DO writes
`courts.last_seen` on each beat and answers, and the agent forces a reconnect after two
missed answers. Reads go through `isOnline()`, which requires a beat within
`PRESENCE_TTL_MS` (90s) — so a Pi that loses power expires on its own. The stored
`courts.online` flag alone is *not* presence: a crashed Pi never sends a close, so that
flag stays `1` indefinitely. The beats also keep the venue's NAT mapping warm, which
prevents the drop as well as detecting it.

**Two cron cadences.** Every 5 minutes: `runHealthChecks` plus the stale sweep. Nightly:
the sweep, retention, and the digest. Health has to be minutes because a camera that
dies the night before a booked match is no use discovered the next morning — and a
missing heartbeat is only ever found by *looking*, never pushed.

**`runStaleSweep` finalizes recordings that never reached a
terminal state (aborting their MPUs), then `runRetention` expires old `ready` rows. The
sweep's thresholds are deliberately asymmetric — see `findStaleRecordings`: 30 min for
`uploading`, 5 h for `recording` (it must outlast the longest real match), and 10 min
once the court has stopped heartbeating, because then nothing is coming back to finish
it.

**An empty capture still produces a valid MP4, so "parts exist" proves nothing.**
ffmpeg with `empty_moov` writes a fragmented-MP4 header even when it receives no
frames, so a camera that never started yields one ~800-byte part. The old guard
(`parts.length === 0`) therefore missed it entirely and the row completed as `ready`
with a working download link to nothing. Found on real hardware: with the camera held
by another process, `rpicam-vid` printed *failed to acquire camera* and **exited with
status 0**. The agent now aborts below `MIN_USABLE_CAPTURE_BYTES`.

**Quote the error lines, not the tail.** libcamera logs several INFO lines *after*
`failed to acquire camera`, so a plain stderr tail shows the operator
pipeline-registration noise instead of the one sentence they can act on.
`captureDiagnosis` prefers lines matching error/fail/busy over the raw tail.

**Bitrate is content-dependent, so byte counts cannot detect a short recording.**
The measured home camera produces ~750 kbit/s of perfectly valid 1080p (a dim,
low-detail scene compresses to almost nothing), against a fleet assumption of
~10 Mbit/s. A byte-per-second heuristic tuned to the latter flags *every* match from
that camera. The real signal is on the agent -- capture ending without anyone asking
it to -- which is content-independent; `MIN_BYTES_PER_SEC` survives only as an
unambiguous floor.

**Thumbnails are generated after the fact, never during capture.** A first frame is a
convenience for telling footage apart before deleting it, so it is not worth a failure
mode in the one path that must not have any -- the agent does not touch it, and no Pi CPU
is spent mid-match. `worker/scripts/make-thumbnails.mjs` reads only the first few MiB of
each finished video with a Range request (the capture is a fragmented MP4, so the opening
fragment already holds a keyframe -- a 4 GB match costs the same as a 40 MB one), decodes
one frame with local ffmpeg, and PUTs it to a super-admin-only route. Recordings made
before a run simply have none, and the UI treats that as normal rather than as an error.

**Alerting exists because nothing used to notice.** Failures push (`abortRecording`,
the short-recording check); absences are polled, because a dead court sends nothing by
definition.

**Offline is not, by itself, an alert.** A club turns cameras off, courts close
overnight, power gets cut deliberately -- paging for a dark court at 23:00 is the noise
that gets a feed muted, and a muted feed is worse than none. What *is* paged is a camera
that vanishes **mid-recording** (`checkInterruptedRecording`): someone is on court, a
booking is being captured, and the footage is at risk. An idle offline court is covered
where it belongs -- the daily digest lists it, and an operator who tries to start gets
an immediate error in the browser. Note that only `recording` counts, not `uploading`:
a draining spool can be away for hours and still deliver, which is the entire point of
the buffer. `notify()` dedupes on a key describing the ongoing *condition*, not the
occurrence — an alerting system that emails once per tick for an overnight outage gets
muted within a week, and a muted one costs the same as none while looking like
coverage. A court coming back clears its key so the next outage is not swallowed by a
stale cooldown. The daily digest is a dead man's switch: without it, a quietly broken
notifier looks exactly like a healthy fleet.

Email is Cloudflare Email Sending to a **verified destination address** (free on any
plan, and off-quota). The binding is optional in `Env` on purpose — it needs an
onboarded sending domain, and until that exists `notify()` logs rather than throwing
inside the cron that also runs retention. A failed send records nothing, so it retries
and self-heals once the domain is onboarded.

**The fixer runs in CI, not in the Worker.** A Worker cannot check out the repo, so a
model editing code from there cannot run `npm run typecheck` — this project's only
check — and would produce plausible patches that do not build. `incidents.ts` files an
issue and fires a `repository_dispatch`; `.github/workflows/fixer.yml` does the work
against a real tree. The brakes are the substance: fingerprints normalise away uuids
and numbers so one recurring fault is one investigation; a hard budget of 5/day, past
which incidents are recorded but escalated to a human instead; a fix that does not
typecheck is discarded; PRs open as drafts and nothing merges or deploys. **The capture
path (`spool.ts`, `uploader.ts`, `camera-agent.ts`) is never patched unattended** — the
prompt says so *and* the workflow enforces it separately, because a rule that lives
only in a prompt is a request, not a guard.

**Two admin tiers.** A venue admin sees only courts already assigned to their venue.
Assigning a camera to a venue, creating venues, and cleaning up abandoned recordings all
live on the super-admin surface (`/api/super/*`, UI at `/super`), gated on
`admins.is_superadmin`. Court assignment used to be self-service, which meant any club
could adopt any unassigned camera in the fleet — including one just installed at another
club. The flag is grantable **only** by `grant-super.mjs`; there is deliberately no
endpoint that can promote an account, for the same reason there is no signup route.
Non-super accounts get **404**, not 403, from every `/api/super` route. A super-admin
also reads recordings and thumbnails across every venue -- they can already delete any of
it, so withholding read access would only break the thumbnail script.

Deleting footage lives on the super surface for a reason: in the R2 console an object is
an opaque key with no court, date or venue beside it, so the easiest mistake is deleting
the wrong one, unrecoverably. `purgeRecording` takes the D1 row, the video, the thumbnail
and any share links together, so nothing is left orphaned.

**`purchased` is deliberately unused.** It's `0` everywhere today; the retention
sweep (`findExpirableRecordings`) only deletes `purchased = 0` rows, so the payments
phase gets retention exemption for free.

**Players start their own match from a QR code** (`worker/src/player.ts`). The sticker
points at `/c/:qrToken`, which can start a recording or say the court is busy — and
*never* reaches footage, because anyone can photograph a sticker. Footage is reached only
through `/m/:token`, a 128-bit secret given to the phone that pressed Start (and
remembered in a cookie scoped to that court's path, so a rescan from the same phone
returns to it). Whoever holds the link can watch, download and stop.

A match (`matches` table, keyed by `session_id`) carries its own end time, chosen on the
venue's slot grid (`venues.timezone`, `.slot_minutes`) so a late-starting group stops at
the end of its booking rather than filming the next one. Start and stop for staff,
players, auto-stop and the cron all go through `startMatch` / `stopMatch` in
`matches.ts` and `stopLiveRecording` in `handlers.ts` — don't add a path around them.
Auto-stop is a Durable Object alarm on the court, backed up by the 5-minute cron
(`endOverdueMatches`); `resume.ts` also refuses to continue a match past its end.

**The free period is an experiment, not a paywall yet.** `courts.free_until` locks
recordings *started* on or after it on the player's share page (`isFree` in
`types.ts`; `purchased = 1` always wins). Judging by start time means flipping the date
never takes back a video already handed out. NULL is free indefinitely. Club staff are
never gated. `recording_events` counts views and downloads -- no IP, cookie or user
agent, but each row names its recording, so it is pseudonymous rather than anonymous --
and only for whole-file requests, so scrubbing through a video is not twenty downloads.
`funnel_events` and `feedback` carry `session_id` (pseudonymous while the match row
exists) and are deleted after 12 months by the nightly cron (`ANALYTICS_RETENTION_DAYS`
in `analytics.ts`).

**The player funnel is measured step by step** (`worker/src/analytics.ts`,
`funnel_events`). Scan → Start → started → shared → opened by someone else → came back
ready → played → watched 30 s → downloaded, plus *why* scans and starts fail. Three rules
keep the numbers honest:

- **Counted per visit or match, never per event.** Before Start a hidden `visit` field
  joins scan to attempt for one phone; after, the match does. No cookie, no IP, no UA
  stored. The pages' own auto-refreshes carry `?r=1` and are not visits.
- **Only browsers count.** A link pasted into WhatsApp is fetched by WhatsApp's servers
  for the preview; without `isPerson()` every share would read as "the group opened
  it". Matched against the UA, never stored.
- **The browser may only report what the server cannot see** (play, watched 30 s, how
  it was shared), through an allowlist. Anyone holding a link can post to `/m/:t/e`.

Feedback is one 👍/👎 per match (`feedback` keyed by `session_id`, so never asked twice
on any phone), revealed only after play or Download, with an optional comment after
the tap. The `/super` funnel counts player-started matches only.

**Auth is asymmetric.** `DEVICE_TOKEN` (a Worker secret) guards the device surface:
`/agent`, part upload, complete, abort, and the segment endpoint. When the secret is
unset, `deviceUnauthorized` returns false and device auth is off entirely. That is the
intended **local-dev** mode and nothing more: in production it means anyone can attach
as an existing court and, because the DO retires the older socket, *evict the real
camera*. `checkDeviceToken` raises a critical alert whenever the secret is missing and
any court is venue-assigned. Set the Pis first, then the secret, or they lock
themselves out. Everything operator-facing requires a session cookie and is
scoped server-side to the admin's venue; the only unauthenticated routes are `/s/:token`
share links and `/m/:token` match links, gated by an unguessable token instead, and the
court page `/c/:qrToken`, which can start a recording but never serves footage.

**Routing.** `worker/src/router.ts` is a hand-rolled matcher: exact segment-count
match, `:name` params, no wildcards or regex. Anything the router doesn't claim falls
through to `env.ASSETS.fetch`.

**Never set `not_found_handling = "single-page-application"`.** That mode makes the
static-assets router answer every *document navigation* with `index.html` **before the
Worker runs**, so `/s/:token` share links served the admin panel and every
`<a download>` downloaded `index.html` instead of the video. It is invisible to curl,
which sends no `Sec-Fetch-Dest: document` — reproduce it with

```bash
curl -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' https://…/s/<token>
```

Client-side routes of the SPA are served explicitly instead: `.get('/super',
h.serveAppShell)`. Add a route there when the SPA gains another real path.

**Downloads support single-range requests** so players can scrub without pulling the
whole file. `parseRange` handles one `bytes=a-b` spec and ignores multi-range.

## Tests

`worker/test/` runs inside workerd via `@cloudflare/vitest-plugin`, with the real
bindings from `wrangler.toml` on local storage and the same D1 migrations production
runs. `FakeCamera` (in `helpers.ts`) connects over the real `/agent` WebSocket and
acknowledges commands, so start, stop, rollback and auto-stop go through the real
Durable Object.

Two traps, both found the hard way:

- **D1 is shared across a test file** -- `resetDb` runs before every test. Without it,
  one test's live recording makes the next test's court look busy.
- **A court's Durable Object outlives a test** (its socket, its alarm), so every test
  seeds a fresh court id rather than reusing one.

The runtime does not reproduce a DO deadlocking on its own stub, so the auto-stop test
asserts the mechanism instead: nothing re-enters the DO's `/command` during its alarm.

## Terraform / Wrangler split

Terraform manages **only** the R2 bucket and the D1 database, because the Cloudflare
provider has known bugs applying Durable Object migrations. The Worker script, DO
migrations, and D1 *table* migrations all belong to Wrangler. The seam is manual:
after `terraform apply`, copy `terraform output database_id` into
`worker/wrangler.toml`'s `[[d1_databases]].database_id`. `RETENTION_DAYS` is
similarly duplicated — it's a Terraform variable *and* a `[vars]` entry; change both.

## Camera agent notes

`CAPTURE_CMD` must emit a **fragmented** MP4 to stdout — the
`-movflags frag_keyframe+empty_moov+default_base_moof` flags are load-bearing, since
parts are uploaded before the file is finished. `padel-agent.env.example` has a
per-hardware command for each Pi/camera combination; the value must stay
double-quoted (it contains a pipe).

**No `CAPTURE_CMD` opens an audio device.** Recording what players say to each other is
a crime in Portugal without each speaker's consent (Código Penal art. 199.º), and players
on the next court can never consent. Video only; any audio feature would need a fresh
legal assessment first.

**The camera is single-access.** If anything else holds it — an `rpicam-vid` preview
left running after aiming the camera, most often — capture exits immediately and the
recording fails. The agent keeps the tail of capture stderr and sends it to
`/api/recordings/:id/abort`, so that shows up in the admin UI as
*"failed to acquire camera"* rather than a silent stall.

The capture child is spawned `detached: true` so stop can `SIGINT` the whole
`rpicam | ffmpeg` process group and let ffmpeg flush its trailing fragment, with a
`SIGKILL` 4s later as a backstop. Finalization is driven off the child's `close`
event, not off the stop command, so a crashed capture still finalizes.

**Capture is only ever paused for the disk, never the network** — and in practice not
even then, since the disk is orders of magnitude faster than the camera. The disk
budget (`DISK_BUDGET_PCT`, default 80% of free space) warns by email at 80% and seals
the recording at 95%: capture stops, the object completes, and the row is marked
`truncated`. Sealing early keeps a valid, playable file that simply stops short.
Dropping older parts instead would leave a hole in the middle, which for MP4 means a
broken file, and filling the filesystem would take journald and sshd down with it —
turning a network outage into a venue visit.

The agent survives its own bugs: `uncaughtException`/`unhandledRejection` do not exit
while a recording is live, part uploads retry rather than being dropped (a dropped part
used to complete into a `ready` object with a silent hole — R2 accepts gaps in the part
sequence), every fetch has a deadline, and a stalled heartbeat loop exits so
`Restart=always` recovers it.

## Conventions

- Worker code targets `@cloudflare/workers-types`; the agent targets Node. Both are
  strict TS with `noUncheckedIndexedAccess`, so index access needs `!` or a guard.
  The worker also sets `verbatimModuleSyntax` — type-only imports need `import type`.
- D1 rows are used raw, so `Recording`/`Court` fields are `snake_case` and booleans
  are `0 | 1`. API responses mostly pass rows through unchanged; `/api/courts` is the
  one that remaps to camelCase.
- Timestamps are epoch milliseconds (`Date.now()`) throughout.
- Secrets never land in the repo: `terraform.tfvars`, `agent/deploy/.fleet.env`, and
  `agent/deploy/padel-agent.env` are all gitignored — edit the `.example` files when
  adding config.
