#!/usr/bin/env bash
# Run ON THE PI. Verify a court camera is fit to record.
#
# Two phases, because they have different bars:
#
#   agent/deploy/court-preflight.sh --bench [--record 15]
#       At home, before you travel. Proves the hardware, the agent and the whole
#       upload path work, and that the venue's WiFi is preloaded. Everything that
#       fails here is cheap to fix; everything that fails at the venue is not.
#
#   agent/deploy/court-preflight.sh --venue [--record 15]
#       At the court, after mounting. Adds the checks that only mean anything in
#       the final position: signal strength, captive portal, WiFi-only operation.
#
# Exit 0 = all passed. Non-zero = at least one FAIL.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/padel-agent.env}"
IFACE="${IFACE:-wlan0}"

MODE=venue; DO_RECORD=0; REC_SECS=15
while [ $# -gt 0 ]; do
  case "$1" in
    --bench) MODE=bench; shift ;;
    --venue) MODE=venue; shift ;;
    --record) DO_RECORD=1; REC_SECS="${2:-15}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done

wifi_country() {
  local c
  c="$(raspi-config nonint get_wifi_country 2>/dev/null | tr -d "[:space:]")"
  [ -z "$c" ] && c="$(sudo -n raspi-config nonint get_wifi_country 2>/dev/null | tr -d "[:space:]")"
  # `iw` is not installed on Raspberry Pi OS Lite, so it is only a fallback.
  if [ -z "$c" ] && command -v iw >/dev/null 2>&1; then
    c="$(iw reg get 2>/dev/null | sed -n 's/^country \([A-Z]*\).*/\1/p' | head -1)"
  fi
  printf '%s' "$c"
}

PASS=0; WARN=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; PASS=$((PASS+1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; WARN=$((WARN+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
COURT_ID="${COURT_ID:-unknown}"
BACKEND="${BACKEND:-}"

printf '\033[1m%s preflight — %s — %s\033[0m\n' \
  "$(echo "$MODE" | tr '[:lower:]' '[:upper:]')" "$COURT_ID" "$(date '+%Y-%m-%d %H:%M:%S %Z')"

# ---------------------------------------------------------------- board ------
hdr "Board"
tr -d '\0' < /proc/device-tree/model 2>/dev/null; echo
THR="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
case "$THR" in
  0x0) ok "no undervoltage or throttling" ;;
  "")  warn "vcgencmd unavailable — cannot check undervoltage" ;;
  *)   bad "throttling flags ${THR} — undervoltage shows up as crashes mid-recording, not an error. Check the PSU and cable." ;;
esac
echo "  temp $(vcgencmd measure_temp 2>/dev/null | cut -d= -f2)"

# --------------------------------------------------------------- camera ------
hdr "Camera"
SENSOR="$(rpicam-hello --list-cameras 2>/dev/null | sed -n 's/^[0-9] : \([a-z0-9]*\).*/\1/p' | head -1)"
# A USB camera (CAPTURE_CMD reads `-f v4l2 ... -i <device>`) never shows up in
# rpicam-hello; check the device it names instead of failing on a missing CSI sensor.
V4L2_DEV="$(sed -n 's/.*-f v4l2 .*-i \([^ ]*\) .*/\1/p' <<<"${CAPTURE_CMD:-}")"
if [ -n "$V4L2_DEV" ]; then
  if [ -e "$V4L2_DEV" ]; then
    ok "USB camera present at ${V4L2_DEV} (encodes H.264 itself; the Pi only copies)"
  else
    bad "CAPTURE_CMD reads ${V4L2_DEV}, which does not exist — USB camera unplugged? Run agent/deploy/usb-camera-bench.sh"
  fi
elif [ -n "$SENSOR" ]; then
  ok "sensor ${SENSOR} detected"
else
  bad "no camera detected — reseat the CSI ribbon, check /boot/firmware/config.txt"
fi
# Pi 4 exposes a hardware H.264 encoder at /dev/video11; Pi 5 has none at all.
# A CAPTURE_CMD using --codec h264 on a board without one fails with "Unable to
# find an appropriate H.264 codec" and yields 0-byte recordings, so check the
# pairing rather than just reporting the encoder.
if [ -e /dev/video11 ]; then
  ENC="$(v4l2-ctl -d /dev/video11 --list-formats-ext 2>/dev/null | grep -m1 -A1 "'H264'" | tail -1 | sed 's/^[[:space:]]*//')"
  echo "  hardware H.264 encoder: ${ENC:-present}"
else
  echo "  no hardware H.264 encoder (software encoding required)"
  if [ -n "$V4L2_DEV" ]; then
    ok "CAPTURE_CMD copies H.264 from the USB camera — no encoder needed on this board"
  elif grep -q -- '--codec h264' <<<"${CAPTURE_CMD:-}"; then
    bad "CAPTURE_CMD uses --codec h264 but this board has no hardware encoder — every recording will be 0 bytes. Use the yuv420 | libx264 command from padel-agent.env.example."
  else
    ok "CAPTURE_CMD matches this board (software encoding)"
  fi
fi

# Smoke-test the REAL configured command — a CAPTURE_CMD that is subtly wrong
# (bad sensor mode, missing frag flags) only shows up as an empty recording later.
if [ -n "${CAPTURE_CMD:-}" ]; then
  if pgrep -x rpicam-vid >/dev/null; then
    warn "camera busy — skipping capture smoke test"
  else
    TMPV="$(mktemp -t capture.XXXXXX.mp4)"
    timeout -k 3 8 bash -c "$CAPTURE_CMD" > "$TMPV" 2>/dev/null
    FRAMES="$(ffprobe -v error -count_frames -select_streams v:0 \
              -show_entries stream=nb_read_frames -of csv=p=0 "$TMPV" 2>/dev/null)"
    SZ="$(stat -c%s "$TMPV" 2>/dev/null || echo 0)"
    if [ "${FRAMES:-0}" -gt 30 ] 2>/dev/null; then
      ok "capture smoke test: ${FRAMES} frames, ${SZ} bytes in ~8s"
    else
      bad "capture produced ${FRAMES:-0} decodable frames (${SZ} bytes) — check CAPTURE_CMD in ${ENV_FILE}"
    fi
    rm -f "$TMPV"
  fi
else
  warn "CAPTURE_CMD unset — the agent will generate filler bytes, not real video"
fi

# -------------------------------------------------------------- network ------
hdr "Network"
if [ "$MODE" = "bench" ]; then
  COUNTRY="$(wifi_country)"
  if [ -n "$COUNTRY" ] && [ "$COUNTRY" != "00" ]; then
    ok "WiFi country set to ${COUNTRY} (5 GHz channels visible)"
  else
    bad "WiFi country unset — 5 GHz stays invisible. sudo raspi-config nonint do_wifi_country XX"
  fi
  WIFI_N="$(nmcli -t -f NAME,TYPE connection show | awk -F: '$2=="802-11-wireless"' | wc -l)"
  echo "  saved WiFi profiles (highest priority first):"
  nmcli -t -f NAME,TYPE,AUTOCONNECT-PRIORITY connection show \
    | awk -F: '$2=="802-11-wireless"{printf "    %-30s priority %s\n",$1,$3}' | sort -k3 -rn
  if [ "${WIFI_N:-0}" -ge 2 ]; then
    ok "${WIFI_N} WiFi profiles saved — venue network looks preloaded"
  else
    bad "only ${WIFI_N} WiFi profile saved. Preload the venue network NOW, at home: sudo agent/deploy/connect-wifi.sh --preload \"Venue-SSID 5G\" 20"
  fi
else
  if nmcli -t -f DEVICE,STATE device | grep -q "^${IFACE}:connected"; then
    LINE="$(nmcli -t -f IN-USE,SSID,SIGNAL,RATE device wifi list ifname "$IFACE" \
            | awk -F: '$1=="*"{print; exit}')"
    SSID="$(printf '%s' "$LINE" | cut -d: -f2)"
    SIG="$(printf  '%s' "$LINE" | cut -d: -f3)"
    RATE="$(printf '%s' "$LINE" | cut -d: -f4)"
    ok "${IFACE} on '${SSID}'  signal ${SIG}%  ${RATE}"
    case "$SIG" in
      ''|*[!0-9]*) warn "could not read signal strength" ;;
      *) [ "$SIG" -lt 45 ] && warn "signal ${SIG}% is low in this position — expect 5 GHz to drop to 2.4" ;;
    esac
  else
    bad "${IFACE} not connected — a mounted court must work on WiFi with no cable"
  fi

  if ip link show eth0 2>/dev/null | grep -q 'state UP'; then
    warn "Ethernet still plugged in — it has the lower route metric, so this run does not prove WiFi works alone"
  fi

  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 --interface "$IFACE" \
          http://connectivitycheck.gstatic.com/generate_204 2>/dev/null || echo 000)"
  case "$CODE" in
    204) ok "real internet on ${IFACE} (no captive portal)" ;;
    200|30[0-9]) bad "CAPTIVE PORTAL on ${IFACE} (HTTP ${CODE}) — the Pi cannot log in. Needs a staff SSID or a MAC allow-list: $(nmcli -g GENERAL.HWADDR device show "$IFACE" 2>/dev/null)" ;;
    *) bad "no route out on ${IFACE} (HTTP ${CODE})" ;;
  esac
fi

if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  ok "tailscale up as $(hostname) — remote access survives you leaving"
else
  bad "tailscale is down — you will have no remote access to this Pi"
fi

# ---------------------------------------------------------------- agent ------
hdr "Agent"
if systemctl is-active --quiet padel-agent; then
  ok "padel-agent running since $(systemctl show padel-agent -p ActiveEnterTimestamp --value)"
else
  bad "padel-agent not running — systemctl status padel-agent"
fi
if systemctl is-enabled --quiet padel-agent 2>/dev/null; then
  ok "enabled at boot — survives a power cut"
else
  bad "not enabled at boot — sudo systemctl enable padel-agent"
fi

if [ -n "$BACKEND" ]; then
  if curl -s --max-time 15 "$BACKEND/api/courts" | grep -q "\"courtId\":\"${COURT_ID}\""; then
    ok "Worker knows court '${COURT_ID}'"
  else
    bad "Worker does not list court '${COURT_ID}' — check COURT_ID and BACKEND in ${ENV_FILE}"
  fi
else
  bad "BACKEND unset in ${ENV_FILE}"
fi

hdr "Storage"
AVAIL="$(df -BM --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')"
if [ "${AVAIL:-0}" -gt 2000 ]; then ok "${AVAIL}MB free on /"
else warn "${AVAIL:-?}MB free on / — parts buffer in RAM, but keep headroom"; fi

# ------------------------------------------------------- end-to-end test -----
# The ONLY check that proves the control channel is really alive. A WebSocket can
# go half-open: the Pi still shows ESTABLISHED, the Durable Object still holds the
# socket so its emptiness check passes, ws.send() succeeds, and the command reaches
# nobody. Start/stop timestamps get recorded for a recording that never happened.
if [ "$DO_RECORD" = "1" ]; then
  hdr "End-to-end recording (${REC_SECS}s)"
  if [ -z "$BACKEND" ]; then
    bad "BACKEND unset — cannot run the end-to-end test"
  else
    RID="$(curl -s --max-time 20 -X POST "$BACKEND/api/recordings/start" \
           -H 'content-type: application/json' -d "{\"courtId\":\"$COURT_ID\"}" \
           | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
    if [ -z "$RID" ]; then
      bad "start refused — no camera online for '${COURT_ID}' (409)"
    else
      echo "  recording ${RID:0:8} for ${REC_SECS}s…"
      sleep "$REC_SECS"
      curl -s --max-time 20 -X POST "$BACKEND/api/recordings/stop" \
        -H 'content-type: application/json' -d "{\"recordingId\":\"$RID\"}" >/dev/null
      ST=""; BY=0
      for _ in $(seq 1 30); do
        sleep 2
        BODY="$(curl -s --max-time 15 "$BACKEND/api/recordings/$RID")"
        ST="$(echo "$BODY" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
        BY="$(echo "$BODY" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
        [ "$ST" = "ready" ] && break
      done
      if [ "$ST" = "ready" ] && [ "${BY:-0}" -gt 0 ]; then
        ok "recorded and uploaded ${BY} bytes"
        echo "  download: ${BACKEND}/api/recordings/${RID}/download"
      elif [ "${BY:-0}" = "0" ]; then
        bad "status '${ST}' with 0 bytes — the start command never reached the agent (half-open socket). Fix: sudo systemctl restart padel-agent"
      else
        bad "stuck in '${ST}' after 60s"
      fi
    fi
  fi
fi

printf '\n\033[1m%d passed, %d warnings, %d failed\033[0m\n' "$PASS" "$WARN" "$FAIL"
if [ "$MODE" = "bench" ] && [ "$FAIL" -eq 0 ]; then
  echo "Bench phase clear. Remaining venue-only unknowns: real signal strength at the"
  echo "mount position, whether the venue WiFi has a captive portal, and lens focus."
fi
[ "$FAIL" -eq 0 ]
