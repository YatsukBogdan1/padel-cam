#!/usr/bin/env bash
# Run on your MAC. One command to aim and focus a camera:
#
#   bash agent/deploy/preview.sh                      # live picture, 1080p30
#   bash agent/deploy/preview.sh --zoom               # live 1:1 centre crop, for focusing
#   bash agent/deploy/preview.sh --still              # full 12MP still, to check the corners
#   bash agent/deploy/preview.sh --meter              # numeric focus score
#   bash agent/deploy/preview.sh pi@other-pi      # a different camera
#   W=1280 H=720 bash agent/deploy/preview.sh         # lighter, if the link lags
#
# Defaults to exactly what the camera RECORDS (1920x1080 @ 30), so the preview
# shows the real framing and the real detail. A 720p preview downscales away the
# fine detail you judge focus by, and can hide the edges of the frame.
#
# Stops the agent so the camera is free, streams, and ALWAYS puts the agent back
# — on Ctrl-C, on a closed viewer window, on an error, or if this machine dies.
#
# Why that matters: the camera is single-access. An rpicam-vid left running means
# every recording afterwards fails with "failed to acquire camera", and the court
# looks online the whole time. That has to be impossible to get wrong, not merely
# documented.

set -uo pipefail

MODE="video"
PI_HOST=""
for arg in "$@"; do
  case "$arg" in
    --meter) MODE="meter" ;;
    --zoom)  MODE="zoom" ;;
    --still) MODE="still" ;;
    --video) MODE="video" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) PI_HOST="$arg" ;;
  esac
done

# Default to whatever the e2e config points at, else the home camera.
HERE="$(cd "$(dirname "$0")" && pwd)"
ENVFILE="${HERE}/../../e2e/.env"
if [ -z "$PI_HOST" ] && [ -f "$ENVFILE" ]; then
  PI_HOST="$(grep -E '^PI_HOST=' "$ENVFILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi
PI_HOST="${PI_HOST:-pi@court-test-1}"

PORT="${PORT:-5000}"
# 8 Mbit/s: enough that blocking artefacts do not masquerade as soft focus. Over
# ssh the link has backpressure, so a slow uplink lags the picture rather than
# flooding the tunnel.
W="${W:-1920}"; H="${H:-1080}"; FPS="${FPS:-30}"; BITRATE="${BITRATE:-8000000}"
# Hard ceiling on the whole session. If this Mac loses power mid-focus, the Pi
# still tidies up after itself.
MAX_SECONDS="${MAX_SECONDS:-1800}"

PI_NAME="${PI_HOST#*@}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }

# ---- teardown ----------------------------------------------------------------

restored=0
cleanup() {
  [ "$restored" = "1" ] && return
  restored=1
  echo
  say "Stopping the preview and restarting the agent…"
  # `[r]picam` so the pattern cannot match this very ssh command line and kill
  # the shell that is running it — which silently half-works.
  ssh -o ConnectTimeout=10 "$PI_HOST" \
    'pkill -f "[p]review-run" 2>/dev/null; pkill -x rpicam-vid 2>/dev/null; pkill -f "[f]focus-meter" 2>/dev/null; true' \
    >/dev/null 2>&1
  ssh -t -o ConnectTimeout=10 "$PI_HOST" 'sudo systemctl start padel-agent' >/dev/null 2>&1

  local state camera
  state="$(ssh -o ConnectTimeout=10 "$PI_HOST" 'systemctl is-active padel-agent' 2>/dev/null)"
  camera="$(ssh -o ConnectTimeout=10 "$PI_HOST" 'pgrep -x rpicam-vid >/dev/null && echo HELD || echo free' 2>/dev/null)"
  if [ "$state" = "active" ] && [ "$camera" = "free" ]; then
    say "Agent is back (camera free). Safe to record."
  else
    warn "Agent state: ${state:-unknown}, camera: ${camera:-unknown}"
    warn "Fix by hand:  ssh $PI_HOST 'pkill -x rpicam-vid; sudo systemctl start padel-agent'"
  fi
}
trap cleanup EXIT INT TERM

# ---- preflight ---------------------------------------------------------------

command -v ffplay >/dev/null || { warn "ffplay not found — brew install ffmpeg"; exit 1; }
ssh -o ConnectTimeout=10 -o BatchMode=yes "$PI_HOST" true 2>/dev/null \
  || { warn "cannot reach $PI_HOST over SSH"; exit 1; }

say "Freeing the camera on $PI_HOST"
ssh -t "$PI_HOST" 'sudo systemctl stop padel-agent' >/dev/null 2>&1
ssh "$PI_HOST" 'pkill -x rpicam-vid 2>/dev/null; sleep 1; true' >/dev/null 2>&1
if ssh "$PI_HOST" 'pgrep -x rpicam-vid >/dev/null'; then
  warn "something is still holding the camera; aborting rather than fighting it"
  exit 1
fi

# ---- focus meter -------------------------------------------------------------

if [ "$MODE" = "meter" ]; then
  say "Focus meter — turn the lens ring until the number PEAKS, then lock it"
  say "Ctrl-C when it stops climbing"
  echo
  ssh -t "$PI_HOST" "cd ~/padel-recording && timeout ${MAX_SECONDS} bash agent/deploy/focus-meter.sh"
  exit 0
fi

# ---- full-resolution still ---------------------------------------------------

# The whole 12MP sensor, not the binned 2028x1080 mode the recording uses. A 120°
# lens is often sharp in the centre and soft at the edges, and a padel court's
# corners are exactly at the edges -- so this is what shows whether the WHOLE frame
# is in focus, which no centre-weighted check can.
if [ "$MODE" = "still" ]; then
  out="${TMPDIR:-/tmp}/${PI_NAME}-focus-$(date +%H%M%S).jpg"
  say "Capturing a full 4056x3040 still from $PI_HOST"
  # -t 2000 lets auto-exposure and white balance settle before the shot.
  ssh "$PI_HOST" 'rpicam-still -n -t 2000 --width 4056 --height 3040 -e jpg -q 95 -o - 2>/dev/null' > "$out"
  if [ ! -s "$out" ]; then
    warn "no image came back — is the camera connected?"; exit 1
  fi
  say "Saved $out ($(du -h "$out" | cut -f1))"
  say "Zoom to 100% and check all four corners, not just the middle"
  open "$out" 2>/dev/null || true
  exit 0
fi

# ---- live focus magnify -------------------------------------------------------

# A 1:1 crop of the sensor's centre, streamed at 1080p. Forcing the full-resolution
# sensor mode matters: without `--mode`, rpicam picks the binned 2028x1080 mode and
# the crop would magnify already-averaged pixels, which hides exactly the softness
# you are trying to see. 1920/4056 x 1080/3040 of the frame is one sensor pixel per
# screen pixel. Output stays 1080p, so a Pi 4 hardware encoder can still do it --
# 4K video it cannot.
ROI="${ROI:-0.2633,0.3224,0.4734,0.3553}"
if [ "$MODE" = "zoom" ]; then
  say "Live 1:1 centre crop from $PI_HOST — turn the ring until fine detail is crispest"
  say "Close the window (or q / Ctrl-C) to finish"
  echo
  ssh "$PI_HOST" "timeout ${MAX_SECONDS} bash -s" 2>/dev/null <<EOS |
MODE_ARGS="--mode 4056:3040:10:P --roi ${ROI} --width 1920 --height 1080 --framerate 10"
if [ -e /dev/video11 ]; then
  rpicam-vid -t 0 --nopreview \$MODE_ARGS --inline --intra 5 --bitrate 8000000 --codec h264 -o - 2>/dev/null \
    | ffmpeg -loglevel error -f h264 -r 10 -i - -c copy -f mpegts -
else
  rpicam-vid -t 0 --nopreview \$MODE_ARGS --codec yuv420 -o - 2>/dev/null \
    | ffmpeg -loglevel error -f rawvideo -pix_fmt yuv420p -s 1920x1080 -r 10 -i - \
        -c:v libx264 -preset ultrafast -tune zerolatency -b:v 8000000 -g 5 -f mpegts -
fi
EOS
  ffplay -hide_banner -loglevel error -an \
      -fflags nobuffer -flags low_delay -framedrop \
      -window_title "${PI_NAME} — focus 1:1" -i - || true
  exit 0
fi

# ---- video preview -----------------------------------------------------------

# The stream comes back over THIS SSH connection, not a listening port.
#
# The obvious design -- ffmpeg listening on the Pi with `tcp://...?listen=1` --
# is broken here: ffmpeg blocks opening its output until a viewer attaches, while
# rpicam-vid is already filling the pipe with raw frames. ffmpeg then starts
# reading mid-frame, and rawvideo has no sync markers to recover from, so every
# frame after is garbage ("Invalid buffer size, packet size N < expected"). A Pi 5
# has no hardware encoder, so the stream is always raw and this always bites.
#
# Piping over ssh avoids it entirely: stdout is readable from the first byte, so
# nothing desynchronises. It also needs no open ports, no firewall rules, and
# TCP backpressure means a slow link makes the camera wait rather than flooding
# the tunnel -- which is what locked this Pi out once already.
say "Streaming ${W}x${H}@${FPS} from $PI_HOST over ssh"
say "Press f for fullscreen; close the window (or q / Ctrl-C) to finish"
echo

# The remote script goes over ssh's stdin and the video comes back on stdout, so
# there is no nested quoting to get wrong and no temp file to clean up.
ssh "$PI_HOST" "timeout ${MAX_SECONDS} bash -s" 2>/dev/null <<EOS |
if [ -e /dev/video11 ]; then
  # Pi 4 and earlier: hardware H.264, so just copy it into the container.
  rpicam-vid -t 0 --nopreview --inline --intra $((FPS / 2)) \
      --width ${W} --height ${H} --framerate ${FPS} --bitrate ${BITRATE} --codec h264 -o - 2>/dev/null \
    | ffmpeg -loglevel error -f h264 -r ${FPS} -i - -c copy -f mpegts -
else
  # Pi 5: no encoder on the board at all, so libx264 does it in software.
  rpicam-vid -t 0 --nopreview \
      --width ${W} --height ${H} --framerate ${FPS} --codec yuv420 -o - 2>/dev/null \
    | ffmpeg -loglevel error -f rawvideo -pix_fmt yuv420p -s ${W}x${H} -r ${FPS} -i - \
        -c:v libx264 -preset ultrafast -tune zerolatency -b:v ${BITRATE} -g $((FPS / 2)) \
        -f mpegts -
fi
EOS
ffplay -hide_banner -loglevel error -an \
    -fflags nobuffer -flags low_delay -framedrop \
    -window_title "${PI_NAME} — preview" -i - || true
