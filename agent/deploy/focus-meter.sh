#!/usr/bin/env bash
# Run ON THE PI. Live focus aid for a manual lens (the IMX477 HQ camera has no
# autofocus). Prints a sharpness score roughly every two seconds — turn the lens
# focus ring until the number PEAKS, then lock the ring.
#
# The score is JPEG byte size at fixed quality: a sharp frame holds more
# high-frequency detail and compresses worse, so bigger = sharper. Expect it to
# roughly double between badly defocused and correctly focused.
#
# Usage (on the Pi):
#   sudo systemctl stop padel-agent     # the camera is single-access
#   agent/deploy/focus-meter.sh
#   # Ctrl-C when the number stops climbing, then:
#   sudo systemctl start padel-agent

set -uo pipefail

W="${W:-1920}"
H="${H:-1080}"
TMP="$(mktemp -t focus.XXXXXX.jpg)"
trap 'rm -f "$TMP"; echo; echo "stopped."' EXIT

if pgrep -x rpicam-vid >/dev/null; then
  echo "!! The camera is already in use (a recording is running, or a preview stream)." >&2
  echo "   sudo systemctl stop padel-agent   # then re-run" >&2
  exit 1
fi

echo "Turn the focus ring until the score peaks. Ctrl-C to stop."
echo
BEST=0
while true; do
  if rpicam-jpeg -o "$TMP" -t 300 --nopreview --width "$W" --height "$H" -q 90 >/dev/null 2>&1; then
    SZ="$(stat -c%s "$TMP")"
    [ "$SZ" -gt "$BEST" ] && BEST="$SZ"
    PCT=$(( SZ * 100 / (BEST > 0 ? BEST : 1) ))
    BAR="$(printf '%*s' $(( PCT / 3 )) '' | tr ' ' '#')"
    printf '\rscore %8d   best %8d   %3d%% %-34s' "$SZ" "$BEST" "$PCT" "$BAR"
  else
    printf '\rcapture failed — is the camera connected?%-40s' ''
  fi
done
