#!/usr/bin/env bash
# Run ON THE PI. Stream a low-latency preview so you can aim and focus the camera
# while watching on your laptop. Works across networks over Tailscale.
#
# Usage (on the Pi):
#   sudo systemctl stop padel-agent            # camera is single-access
#   agent/deploy/preview-stream.sh 100.x.y.z   # your laptop's TAILNET ip
#   agent/deploy/preview-stream.sh 100.x.y.z 5000 tcp
#
# Start the viewer on your LAPTOP FIRST (the script prints the exact command).

set -euo pipefail

TARGET="${1:?usage: preview-stream.sh <viewer-ip> [port] [udp|tcp]}"
PORT="${2:-5000}"
MODE="${3:-udp}"
W="${W:-1280}"; H="${H:-720}"; FPS="${FPS:-25}"; BITRATE="${BITRATE:-3000000}"
PI_HOST="$(hostname)"   # printed for the viewer; must resolve on the LAPTOP, so
                        # this relies on Tailscale MagicDNS knowing this Pi.

if pgrep -x rpicam-vid >/dev/null; then
  echo "!! Camera already in use. sudo systemctl stop padel-agent" >&2
  exit 1
fi

# Pi 4 has a hardware H.264 encoder at /dev/video11; Pi 5 has none at all and
# `rpicam-vid --codec h264` fails outright with "Unable to find an appropriate
# H.264 codec". Detect which board this is and build the matching pipeline.
if [ -e /dev/video11 ]; then
  ENCODER="hardware (bcm2835 H.264)"
  # --inline repeats SPS/PPS so a viewer joining late can still lock on.
  # --intra keeps keyframes frequent so UDP loss recovers in well under a second.
  CAM=(rpicam-vid -t 0 --nopreview --inline --intra $((FPS / 2))
       --width "$W" --height "$H" --framerate "$FPS" --bitrate "$BITRATE" --codec h264)
  FF_IN=(-f h264 -r "$FPS" -i - -c copy)
else
  ENCODER="software (libx264 - no hardware encoder on this board)"
  CAM=(rpicam-vid -t 0 --nopreview
       --width "$W" --height "$H" --framerate "$FPS" --codec yuv420)
  FF_IN=(-f rawvideo -pix_fmt yuv420p -s "${W}x${H}" -r "$FPS" -i -
         -c:v libx264 -preset ultrafast -tune zerolatency
         -b:v "$BITRATE" -g $((FPS / 2)))
fi

PI_HOST="$(hostname)"

echo "=============================================================="
echo " Encoder: ${ENCODER}"
echo
echo " Run this on your LAPTOP first, then leave it waiting:"
echo
if [ "$MODE" = "tcp" ]; then
  echo "   ffplay -hide_banner -an -fflags nobuffer -flags low_delay -framedrop \\"
  echo "     -i tcp://${PI_HOST}:${PORT}"
else
  echo "   ffplay -hide_banner -an -fflags nobuffer -flags low_delay -framedrop \\"
  echo "     -analyzeduration 0 -probesize 32768 \\"
  echo "     -i \"udp://0.0.0.0:${PORT}?fifo_size=1000000&overrun_nonfatal=1\""
fi
echo "=============================================================="
echo

if [ "$MODE" = "tcp" ]; then
  echo "==> TCP preview on :${PORT} (waiting for the viewer to connect)"
  OUT="tcp://0.0.0.0:${PORT}?listen=1"
else
  # 1128 = 6x188. TS packets are 188 bytes, so keeping the datagram a whole multiple
  # means one lost datagram corrupts one TS packet, not two. Must stay under
  # tailscale0's 1280-byte MTU, so 7x188=1316 is too big.
  # anything larger fragments and arrives as a garbled picture.
  echo "==> UDP preview to ${TARGET}:${PORT}"
  OUT="udp://${TARGET}:${PORT}?pkt_size=1128"
fi

"${CAM[@]}" -o - 2>/dev/null \
  | ffmpeg -loglevel warning "${FF_IN[@]}" -f mpegts "$OUT"
