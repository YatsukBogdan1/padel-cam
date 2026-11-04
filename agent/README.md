# Camera agent — Raspberry Pi setup

Runs on the Pi at the court. Dials out to your Worker over WebSocket, waits for
start/stop, and streams the camera as fragmented-MP4 multipart parts into R2.

## 1. Prerequisites on the Pi

Raspberry Pi OS (Bookworm recommended). Install Node 20+ and ffmpeg:

```bash
sudo apt update
sudo apt install -y ffmpeg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # should be v20+
```

CSI camera modules use `rpicam-*` (preinstalled on Bookworm). Confirm the camera:

```bash
rpicam-hello -t 2000                       # CSI module: brief preview
# or for USB:
v4l2-ctl --list-formats-ext -d /dev/video0 # note whether it offers H264 or MJPEG
```

## 2. Get the code and install

```bash
git clone <your-repo> ~/padel-recording
cd ~/padel-recording/agent
npm install
```

## 3. Configure

```bash
cp deploy/padel-agent.env.example deploy/padel-agent.env
nano deploy/padel-agent.env
```

Set `COURT_ID`, `BACKEND` (your `workers.dev` URL), `DEVICE_TOKEN` (see below), and
**uncomment the one `CAPTURE_CMD`** matching your Pi + camera. Test it by hand first:

```bash
set -a; . deploy/padel-agent.env; set +a
timeout 5 sh -c "$CAPTURE_CMD" > /tmp/test.mp4
ffprobe /tmp/test.mp4                       # should report a valid H.264 MP4
```

Quick end-to-end from the terminal (Ctrl-C to stop the agent):

```bash
npm start
```

Then open your Worker URL in a browser, pick this court, Start/Stop, and Download.

## 4. Device token (recommended before going live)

On your dev machine, set the secret on the Worker so only your Pis can connect:

```bash
cd worker && npx wrangler secret put DEVICE_TOKEN     # paste a long random string
```

Put the **same** value in `DEVICE_TOKEN` in `padel-agent.env`. With the secret set,
the Worker rejects any `/agent`, part-upload, or complete request without it (401).
Leave it blank on both sides to keep auth off during early testing.

## 5. Run as a service (auto-start + auto-restart)

```bash
sudo cp deploy/padel-agent.service /etc/systemd/system/padel-agent.service
# edit the User/paths in the unit if you didn't clone to /home/pi/padel-recording
sudo systemctl daemon-reload
sudo systemctl enable --now padel-agent
```

Operate it:

```bash
systemctl status padel-agent
journalctl -u padel-agent -f      # live logs: connect, ▶ recording, ↑ part, ✓ stopped
sudo systemctl restart padel-agent
```

## One Pi per court

Each court is a separate Pi with its own `COURT_ID`. Repeat sections 2–5 per Pi; they
all point at the same `BACKEND` and share the same `DEVICE_TOKEN`.

## Remote access — SSH any court through NAT (Tailscale)

The Pis sit behind the venue's router, so you can't SSH *in* directly. Tailscale gives
each Pi an outbound connection to your private network and a stable name, so you can
`ssh pi@court-1` from anywhere to debug live.

**One-time, in the Tailscale admin console** (login.tailscale.com):

1. Access controls → add a tag and an SSH rule so you can reach the cameras:
   ```jsonc
   {
     "tagOwners": { "tag:padel-cam": ["autogroup:admin"] },
     "acls": [
       { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:padel-cam:*"] }
     ],
     "ssh": [
       {
         "action": "accept",
         "src": ["autogroup:member"],
         "dst": ["tag:padel-cam"],
         "users": ["pi", "root"]
       }
     ]
   }
   ```
2. Settings → Keys → **Generate auth key**: make it **Reusable**, **Pre-approved**, and
   tagged **`tag:padel-cam`**. Copy it (`tskey-auth-…`) — you'll reuse it for every Pi.

Then on a Pi, either run the fleet script below (recommended) or do it manually:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=court-1 --authkey=tskey-auth-XXXX
```

Now from your laptop (also on the tailnet): `ssh pi@court-1`. Tailscale handles NAT
traversal and SSH auth — no port forwarding, no key distribution.

## Headless bring-up from your LAN (no monitor/keyboard)

For flashing cards in the office and provisioning each Pi over Ethernet in one command.

**1. Flash the SD card — once, reused for every Pi.** In Raspberry Pi Imager, click the
gear / *Edit Settings* before writing:
- **Enable SSH** → *Allow public-key authentication* and paste your laptop's public key
  (`~/.ssh/id_ed25519.pub`). A password also works — the script will install your key.
- Set **username** `pi`. Configure **Wi-Fi** only if you're not on Ethernet.
- Leave **hostname** as `raspberrypi` (do Pis one at a time) or set a unique one per card.

Imager remembers these, so every card is written identically.

**2. Boot the Pi on your LAN** (Ethernet is simplest — it just gets DHCP).

**3. From this repo on your laptop, provision it:**

```bash
cd agent/deploy
cp .fleet.env.example .fleet.env      # fill TS_AUTHKEY, BACKEND, DEVICE_TOKEN once
./setup-pi.sh court-1 raspberrypi.local
```

`setup-pi.sh` waits for the Pi, installs your SSH key if needed, copies the repo, and runs
the full provisioning below. Repeat for each Pi with a new court id
(`./setup-pi.sh court-2 raspberrypi.local`) — one at a time if they share `raspberrypi.local`.

When it finishes, the Pi is on your tailnet; reach it anywhere with `ssh pi@court-1`.

## Fast fleet provisioning (runs on the Pi)

`setup-pi.sh` above calls `deploy/provision-pi.sh` for you. To run it directly on a Pi
you're already SSH'd into (deps, Tailscale SSH, agent service — one idempotent run):

```bash
sudo COURT_ID=court-1 \
     TS_AUTHKEY=tskey-auth-XXXX \
     BACKEND=https://padel-worker.YOUR-SUBDOMAIN.workers.dev \
     DEVICE_TOKEN=your-shared-secret \
     bash agent/deploy/provision-pi.sh
```

It sets the tailnet hostname to `COURT_ID`, writes `deploy/padel-agent.env` (still
**review `CAPTURE_CMD`** for your camera), and starts the service.

## Troubleshooting

- **Camera not detected** (`rpicam-hello --list-cameras` is empty) — on Bookworm most
  official modules auto-detect, but the **HQ camera (IMX477)** and some setups need an
  explicit overlay. Edit `/boot/firmware/config.txt`, set `camera_auto_detect=0` and add
  `dtoverlay=imx477` (use the overlay matching your sensor: `imx219` for Module v2,
  `imx708` for Module v3), then `sudo reboot`. Re-check with `rpicam-hello --list-cameras`.
- **`$CAPTURE_CMD` looks empty when you test it** — the value must be wrapped in double
  quotes in `padel-agent.env` (it contains spaces and a `|`). Unquoted, `. padel-agent.env`
  mis-parses it. Fix the quotes, then `set -a; . deploy/padel-agent.env; set +a; echo "$CAPTURE_CMD"`.
- **No "connected" log** — check `BACKEND` (https, no trailing slash) and that
  `DEVICE_TOKEN` matches the Worker secret. A 401 in logs means a token mismatch.
- **`no data captured — marking failed`** — `CAPTURE_CMD` produced nothing; run the
  section-3 hand test and check `journalctl` for the `capture:` stderr lines.
- **Choppy/dropped video** — lower resolution/framerate in `CAPTURE_CMD`, or raise
  `PART_SIZE_MB`. On a Pi 5, prefer 720p (software encoding is CPU-bound).
