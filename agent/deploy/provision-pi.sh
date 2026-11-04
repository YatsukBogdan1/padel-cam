#!/usr/bin/env bash
# Provision a Raspberry Pi as a padel court: dependencies, Tailscale SSH (remote
# access through NAT), and the camera agent as a systemd service.
#
# Run from a cloned repo on the Pi:
#   sudo COURT_ID=court-1 \
#        TS_AUTHKEY=tskey-auth-xxxx \
#        BACKEND=https://padel-worker.YOUR-SUBDOMAIN.workers.dev \
#        DEVICE_TOKEN=your-shared-secret \
#        bash agent/deploy/provision-pi.sh
#
# Idempotent: safe to re-run to update config or re-join Tailscale.

set -euo pipefail

: "${COURT_ID:?set COURT_ID (e.g. court-1)}"
: "${TS_AUTHKEY:?set TS_AUTHKEY (Tailscale reusable auth key, tagged tag:padel-cam)}"
: "${BACKEND:?set BACKEND (your deployed Worker URL)}"
DEVICE_TOKEN="${DEVICE_TOKEN:-}"
PART_SIZE_MB="${PART_SIZE_MB:-5}"
RUN_USER="${RUN_USER:-${SUDO_USER:-pi}}"

# Resolve repo paths from this script's location (…/agent/deploy/provision-pi.sh).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Provisioning ${COURT_ID} (user: ${RUN_USER}, agent: ${AGENT_DIR})"

# 1. System dependencies -------------------------------------------------------
echo "==> Installing ffmpeg + camera tools + Node.js"
apt-get update -y
# v4l-utils (v4l2-ctl) lists what a USB camera offers; usb-camera-bench.sh and the
# USB camera detection below use it, and fall back to ffmpeg when it is missing.
apt-get install -y ffmpeg curl v4l-utils

# rpicam-apps provides rpicam-vid / rpicam-hello / rpicam-jpeg. CAPTURE_CMD and
# every helper script (preflight, focus-meter, preview-stream) depend on them.
# Raspberry Pi OS Lite normally ships them, but don't assume — and images older
# than Bookworm name the package libcamera-apps.
if ! command -v rpicam-vid >/dev/null && ! command -v libcamera-vid >/dev/null; then
  echo "==> Installing camera apps"
  apt-get install -y rpicam-apps || apt-get install -y libcamera-apps
fi
# Probe Node's version WITHOUT letting a missing binary kill the script: under
# `set -euo pipefail`, a command substitution in an assignment propagates its exit
# status, so `node -v` returning 127 on a fresh image aborted provisioning here.
NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
fi
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# 1b. Camera device tree -------------------------------------------------------
# Bookworm auto-detects the IMX477 HQ camera and the v2/v3 modules, so usually
# nothing is needed here — court-1 was never configured by hand. This makes that
# implicit assumption explicit, and gives you an escape hatch: set CAMERA_OVERLAY
# (e.g. imx477) to pin a specific sensor when auto-detection fails, which happens
# with long ribbon cables and some HQ camera revisions.
CONFIG_TXT=/boot/firmware/config.txt
[ -f "$CONFIG_TXT" ] || CONFIG_TXT=/boot/config.txt
CAMERA_OVERLAY="${CAMERA_OVERLAY:-}"
CAMERA_REBOOT=0
if [ -f "$CONFIG_TXT" ]; then
  if [ -n "$CAMERA_OVERLAY" ]; then
    echo "==> Pinning camera overlay: ${CAMERA_OVERLAY}"
    sed -i 's/^camera_auto_detect=.*/camera_auto_detect=0/' "$CONFIG_TXT"
    grep -q '^camera_auto_detect=' "$CONFIG_TXT" || echo 'camera_auto_detect=0' >>"$CONFIG_TXT"
    grep -q "^dtoverlay=${CAMERA_OVERLAY}\$" "$CONFIG_TXT" || echo "dtoverlay=${CAMERA_OVERLAY}" >>"$CONFIG_TXT"
    CAMERA_REBOOT=1
  elif ! grep -q '^camera_auto_detect=1' "$CONFIG_TXT"; then
    echo "==> Enabling camera auto-detect"
    sed -i 's/^camera_auto_detect=.*/camera_auto_detect=1/' "$CONFIG_TXT"
    grep -q '^camera_auto_detect=' "$CONFIG_TXT" || echo 'camera_auto_detect=1' >>"$CONFIG_TXT"
    CAMERA_REBOOT=1
  fi
fi

# 2. Tailscale + SSH -----------------------------------------------------------
echo "==> Installing Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
# A stale auth key must not block a re-run. Auth keys last at most 90 days and
# single-use keys are spent by the first Pi that claims one, so an already-joined
# node re-applies settings without needing a key at all.
if tailscale status >/dev/null 2>&1; then
  echo "==> Already on a tailnet — applying settings without an auth key"
  tailscale up --ssh --hostname="${COURT_ID}" --accept-dns=true
else
  echo "==> Joining tailnet as '${COURT_ID}' with SSH enabled"
  if ! tailscale up --ssh --hostname="${COURT_ID}" --authkey="${TS_AUTHKEY}" --accept-dns=true; then
    echo
    echo "!! tailscale up failed. The usual cause is an expired, revoked or already-spent"
    echo "   TS_AUTHKEY in agent/deploy/.fleet.env."
    echo
    echo "   Fix A - new key (do this for the fleet): generate a REUSABLE, pre-approved"
    echo "   key tagged tag:padel-cam at https://login.tailscale.com/admin/settings/keys"
    echo "   put it in .fleet.env, then re-run setup-pi.sh."
    echo
    echo "   Fix B - unblock this Pi now: authenticate interactively, then re-run."
    echo "     sudo tailscale up --ssh --hostname='${COURT_ID}'"
    exit 1
  fi
fi
hostnamectl set-hostname "${COURT_ID}" 2>/dev/null || true

# 3. Agent dependencies --------------------------------------------------------
echo "==> Installing agent npm dependencies"
sudo -u "${RUN_USER}" bash -c "cd '${AGENT_DIR}' && npm install"

# 4. Agent config --------------------------------------------------------------
ENV_FILE="${AGENT_DIR}/deploy/padel-agent.env"
ENV_CREATED=0
if [ ! -f "${ENV_FILE}" ]; then
  cp "${AGENT_DIR}/deploy/padel-agent.env.example" "${ENV_FILE}"
  ENV_CREATED=1
  echo "==> Created ${ENV_FILE} from example — review CAPTURE_CMD for your camera!"
fi
# Upsert KEY=VALUE, leaving every other line (especially CAPTURE_CMD) untouched.
# printf-based so values containing / & | \ are safe; idempotent across re-runs.
set_kv() { # key value
  local tmp="${ENV_FILE}.tmp"
  grep -v "^$1=" "${ENV_FILE}" >"${tmp}" || true
  printf '%s="%s"\n' "$1" "$2" >>"${tmp}"
  mv "${tmp}" "${ENV_FILE}"
}
set_kv COURT_ID "${COURT_ID}"
set_kv BACKEND "${BACKEND}"
set_kv DEVICE_TOKEN "${DEVICE_TOKEN}"
set_kv PART_SIZE_MB "${PART_SIZE_MB}"
set_kv AGENT_SHA "${AGENT_SHA:-unknown}"

# CAPTURE_CMD must match the board. The example ships the Pi 4 line (hardware
# H.264 via /dev/video11). A Pi 5 has NO hardware video encoder at all, and
# `rpicam-vid --codec h264` there fails outright with "Unable to find an
# appropriate H.264 codec" — which surfaces as recordings of 0 bytes with no
# obvious cause. Pick the right one rather than leaving it to be discovered.
# A USB (UVC) camera that encodes H.264 itself beats both: the Pi only copies bytes,
# on any board. usb-camera-bench.sh --detect prints its CAPTURE_CMD (with a stable
# /dev/v4l/by-id path) or nothing, so detection logic lives in one place. Like the
# Pi 5 case, a fresh env file gets it; an existing CAPTURE_CMD is never overwritten.
USB_CAPTURE="$(bash "${SCRIPT_DIR}/usb-camera-bench.sh" --detect 2>/dev/null || true)"
SW_CAPTURE='rpicam-vid -t 0 --nopreview --width 1920 --height 1080 --framerate 30 --codec yuv420 -o - | ffmpeg -loglevel error -f rawvideo -pix_fmt yuv420p -s 1920x1080 -r 30 -i - -c:v libx264 -preset veryfast -tune zerolatency -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 -'
if [ -n "$USB_CAPTURE" ]; then
  if [ "$ENV_CREATED" = "1" ]; then
    echo "==> USB camera with on-camera H.264 found — selecting USB capture"
    set_kv CAPTURE_CMD "${USB_CAPTURE}"
  elif ! grep -q '^CAPTURE_CMD=.*-input_format h264' "${ENV_FILE}"; then
    echo
    echo "!! A USB camera offering H.264 is plugged in, but CAPTURE_CMD does not use it."
    echo "   To record from it, replace CAPTURE_CMD in ${ENV_FILE} with:"
    echo "   CAPTURE_CMD=\"${USB_CAPTURE}\""
    echo
  fi
elif [ ! -e /dev/video11 ]; then
  if [ "$ENV_CREATED" = "1" ]; then
    echo "==> No hardware H.264 encoder on this board — selecting software capture"
    set_kv CAPTURE_CMD "${SW_CAPTURE}"
  elif grep -q '^CAPTURE_CMD=.*--codec h264' "${ENV_FILE}"; then
    # Never clobber a CAPTURE_CMD the operator may have tuned; warn loudly instead.
    echo
    echo "!! CAPTURE_CMD uses --codec h264, but this board has no hardware encoder."
    echo "   Recordings will produce 0 bytes. Replace it in ${ENV_FILE} with:"
    echo "   CAPTURE_CMD=\"${SW_CAPTURE}\""
    echo
  fi
fi
chown "${RUN_USER}:${RUN_USER}" "${ENV_FILE}"

# 4b. SD card survival ---------------------------------------------------------
# Card wear is the most common way a field Pi dies, and the agent now spools
# video to disk during a network outage — so the journal must stop being the
# other thing writing to it without limit.
echo "==> Capping the systemd journal at 200M"
sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=200M/' /etc/systemd/journald.conf
grep -q '^SystemMaxUse=' /etc/systemd/journald.conf || echo 'SystemMaxUse=200M' >>/etc/systemd/journald.conf
systemctl restart systemd-journald

# The spool: captured parts land here first and are deleted once R2 has them.
# Separate directory so `du` answers "how much unsent footage is on this Pi".
SPOOL_DIR="${SPOOL_DIR:-/var/lib/padel-agent/spool}"
echo "==> Preparing spool at ${SPOOL_DIR}"
mkdir -p "${SPOOL_DIR}"
chown -R "${RUN_USER}:${RUN_USER}" "$(dirname "${SPOOL_DIR}")"
set_kv SPOOL_DIR "${SPOOL_DIR}"

# Scoped to exactly the verbs the agent and the recovery runbook need. NOT
# blanket NOPASSWD: this account is reachable over Tailscale SSH from anywhere.
echo "==> Installing scoped sudoers rule"
cat >/etc/sudoers.d/padel-agent <<EOF
${RUN_USER} ALL=(root) NOPASSWD: /bin/systemctl restart padel-agent, /bin/systemctl stop padel-agent, /bin/systemctl start padel-agent, /bin/systemctl status padel-agent, /usr/bin/systemctl restart padel-agent, /usr/bin/systemctl stop padel-agent, /usr/bin/systemctl start padel-agent, /usr/bin/systemctl status padel-agent
EOF
chmod 0440 /etc/sudoers.d/padel-agent
visudo -cf /etc/sudoers.d/padel-agent >/dev/null || {
  echo "!! sudoers rule rejected — removing it rather than risking a broken sudo"
  rm -f /etc/sudoers.d/padel-agent
}

# 5. systemd service -----------------------------------------------------------
echo "==> Installing systemd service"
UNIT=/etc/systemd/system/padel-agent.service
sed -e "s|^User=.*|User=${RUN_USER}|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=${AGENT_DIR}|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=${ENV_FILE}|" \
    "${AGENT_DIR}/deploy/padel-agent.service" >"${UNIT}"
systemctl daemon-reload
systemctl enable --now padel-agent
systemctl restart padel-agent

# 6. Camera sanity -------------------------------------------------------------
# Report this here rather than leaving it to discover at a venue. A camera that
# needs a reboot to appear looks identical to a camera that is broken.
echo
if [ -n "$USB_CAPTURE" ]; then
  echo "==> USB H.264 camera detected: $(sed -n 's/.* -i \([^ ]*\) .*/\1/p' <<<"$USB_CAPTURE")"
fi
if rpicam-hello --list-cameras 2>/dev/null | grep -q ':'; then
  echo "==> Camera detected: $(rpicam-hello --list-cameras 2>/dev/null | sed -n 's/^[0-9] : \([a-z0-9]*\).*/\1/p' | head -1)"
elif [ "$CAMERA_REBOOT" = "1" ]; then
  echo "==> Camera not detected YET — config.txt was just changed. Reboot, then re-check:"
  echo "    sudo reboot   # then:  rpicam-hello --list-cameras"
elif [ -z "$USB_CAPTURE" ]; then
  echo "!! Camera NOT detected. Check the CSI ribbon seating (contacts toward the board),"
  echo "   then re-run with an explicit sensor, e.g.:"
  echo "     sudo CAMERA_OVERLAY=imx477 ... bash agent/deploy/provision-pi.sh"
fi

echo
echo "==> Done. ${COURT_ID} is on your tailnet and recording-ready."
echo "    SSH from anywhere:   ssh ${RUN_USER}@${COURT_ID}"
echo "    Live agent logs:     journalctl -u padel-agent -f"
echo "    Review capture cmd:  ${ENV_FILE}"
if [ "$CAMERA_REBOOT" = "1" ]; then
  echo "    REBOOT REQUIRED:     sudo reboot  (config.txt changed)"
fi
