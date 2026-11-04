#!/usr/bin/env bash
# Arrival bench for a USB (UVC) camera that should encode H.264 itself -- written
# for the ELP USB4KCAM01H-H120 (Sony IMX415, 4K30), works for any UVC camera.
#
# A product listing saying "H.264" does not prove the camera encodes it. This does:
# it asks the camera's own V4L2 node for H.264, copies the bytes into a fragmented
# MP4 exactly as the agent would (-c copy, same -movflags), and measures what came
# out -- bitrate against the ~11 Mbit/s uplink, keyframe interval, real frame rate,
# Pi CPU load (near idle = the Pi is only copying), no audio -- then saves a
# full-resolution frame for a human to look at.
#
# Usage
#   On your Mac, from the repo (copies this script to the Pi, runs it there, and
#   fetches the report and frames back):
#     agent/deploy/usb-camera-bench.sh --remote pi@court-test-2
#
#   On the Pi:
#     agent/deploy/usb-camera-bench.sh                  # find the camera, record 60 s
#     agent/deploy/usb-camera-bench.sh /dev/video2      # use this node
#     agent/deploy/usb-camera-bench.sh --size 2560x1440 --secs 30
#     agent/deploy/usb-camera-bench.sh --focus          # live focus score for the lens ring
#     agent/deploy/usb-camera-bench.sh --detect         # print CAPTURE_CMD (provision-pi.sh)
#
#   Every option also works after --remote user@host.
#
# Exit: 0 = meets the spec: H.264 from the camera at 3840x2160, >= 25 fps, regular
#           keyframes.
#       2 = the camera does emit H.264, but misses the spec somewhere (no 4K, too few
#           fps, keyframes too rare...). Read the FAIL lines.
#       1 = no H.264 from the camera, or capture did not work at all.
#
# Needs only ffmpeg/ffprobe (provision-pi.sh installs them). Uses v4l2-ctl from
# v4l-utils when present and falls back to ffmpeg's own format listing when not.
# Does not touch the padel-agent service or its config.

set -uo pipefail

SECS="${SECS:-60}"
UPLINK_MBIT="${UPLINK_MBIT:-11}"   # measured Pi 4 Wi-Fi uplink, reference.md
MIN_FPS=25                          # operations.md camera requirement
WANT_SIZES="3840x2160 2592x1944 2560x1440 2048x1536 1920x1080"
# Agent capture flags. frag_duration (microseconds) cuts a fragment at least every
# 2 s even if the camera's keyframes are rare: with frag_keyframe alone, ffmpeg holds
# everything since the last keyframe in RAM and the spool receives nothing.
FRAG_FLAGS="-frag_duration 2000000 -movflags frag_keyframe+empty_moov+default_base_moof"

MODE=bench; DEV=""; SIZE=""; FPS=""; REMOTE=""
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="${2:-}"
              [ -n "$REMOTE" ] || { echo "usage: --remote user@host" >&2; exit 64; }
              shift 2; continue ;;
    --secs)   SECS="${2:-}"; PASS_ARGS+=("$1" "$SECS"); shift 2; continue ;;
    --size)   SIZE="${2:-}"; PASS_ARGS+=("$1" "$SIZE"); shift 2; continue ;;
    --fps)    FPS="${2:-}";  PASS_ARGS+=("$1" "$FPS");  shift 2; continue ;;
    --detect) MODE=detect ;;
    --focus)  MODE=focus ;;
    -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    /dev/*)   DEV="$1" ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 64 ;;
  esac
  PASS_ARGS+=("$1"); shift
done
case "$SECS" in ''|*[!0-9]*) echo "--secs needs a whole number of seconds" >&2; exit 64 ;; esac

# =========================================================== remote (Mac) ====
# Runs on your Mac. Bash 3.2 compatible on purpose -- that is what macOS ships.
if [ -n "$REMOTE" ]; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  # In the Pi user's home, NOT /tmp: on Raspberry Pi OS trixie /tmp is RAM (tmpfs),
  # and a minute of 4K can be hundreds of MB.
  RDIR="usb-cam-bench"
  ROUT="${RDIR}/${STAMP}"
  LOCAL="${LOCAL_DIR:-$HOME/usb-cam-bench/${STAMP}}"

  echo "==> [on your Mac] copying the bench script to ${REMOTE}:~/${RDIR}/"
  if ! ssh -o ConnectTimeout=15 "$REMOTE" "mkdir -p ~/${RDIR}"; then
    echo "!! Cannot reach ${REMOTE} over SSH. Is it on the tailnet?  (on your Mac: tailscale status)" >&2
    exit 1
  fi
  scp -q "$SELF" "${REMOTE}:${RDIR}/usb-camera-bench.sh" || exit 1

  ARGS=""
  for a in ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}; do ARGS="${ARGS} $(printf '%q' "$a")"; done
  echo "==> [on the Pi] running the bench (allow ~$((SECS + 150)) s; progress below)"
  echo
  ssh -t "$REMOTE" "OUT=\$HOME/${ROUT} SECS=${SECS} UPLINK_MBIT=${UPLINK_MBIT} bash \$HOME/${RDIR}/usb-camera-bench.sh${ARGS}"
  RC=$?
  [ "$MODE" = bench ] || exit "$RC"

  echo
  echo "==> [on your Mac] fetching the report and frames into ${LOCAL}"
  mkdir -p "$LOCAL"
  scp -q "${REMOTE}:${ROUT}/report.txt" "${REMOTE}:${ROUT}/*.jpg" "$LOCAL/" 2>/dev/null \
    || echo "   (some files were not produced -- see the report above)"
  echo
  echo "LOOK AT THE FRAMES -- on your Mac:"
  echo "  open '${LOCAL}'/*.jpg"
  echo "  frame-full.jpg         coverage: both back glasses and both side walls in frame?"
  echo "  frame-centre-1to1.jpg  focus, at 1:1: is the far net / fence crisp?"
  echo
  echo "To watch the 60 s clip (VLC or Chrome; QuickTime/Safari cannot play fragmented MP4) -- on your Mac:"
  echo "  scp '${REMOTE}:${ROUT}/bench.mp4' '${LOCAL}/' && open -a VLC '${LOCAL}/bench.mp4'"
  exit "$RC"
fi

# ============================================================ on the Pi =====

# Decimal points must be '.', whatever locale the Pi was imaged with.
export LC_ALL=C

have() { command -v "$1" >/dev/null 2>&1; }

# Every /dev/videoN driven by uvcvideo (USB cameras), via sysfs -- needs no tools.
uvc_nodes() {
  local s
  for s in /sys/class/video4linux/video*; do
    [ -e "$s" ] || continue
    [ "$(basename "$(readlink -f "$s/device/driver" 2>/dev/null)")" = uvcvideo ] || continue
    echo "/dev/$(basename "$s")"
  done | sort -V
}

# "FOURCC WIDTHxHEIGHT FPS" per mode. FPS is "?" when only ffmpeg could list it.
formats_of() {
  local dev="$1"
  if have v4l2-ctl; then
    v4l2-ctl -d "$dev" --list-formats-ext 2>/dev/null | awk -v Q="'" '
      index($0, "]: " Q)               { split($0, p, Q); f = p[2]; s = ""; next }
      $1 == "Size:" && $2 == "Discrete" { s = $3; next }
      $1 == "Interval:" && s != ""      { x = $4; sub(/^\(/, "", x); printf "%s %s %g\n", f, s, x + 0 }'
  else
    ffmpeg -hide_banner -nostdin -f v4l2 -list_formats all -i "$dev" 2>&1 | awk -F' : ' '
      /Compressed:/ {
        n = split($1, a, " "); c = a[n]
        if (c == "h264") c = "H264"; else if (c == "mjpeg") c = "MJPG"; else next
        m = split($3, s, " "); for (i = 1; i <= m; i++) print c, s[i], "?"
      }'
  fi
}

# Pick "SIZE FPS" for a fourcc from formats_of output on stdin.
pick_mode() { # fourcc
  awk -v F="$1" -v WANT="$WANT_SIZES" -v SZ="$SIZE" -v FR="$FPS" '
    $1 == F { ok[$2] = 1; if ($3 == "?") q[$2] = 1; else if ($3 + 0 > mx[$2]) mx[$2] = $3 + 0
              if ($3 + 0 == 30) has30[$2] = 1
              split($2, d, "x"); if (d[1] * d[2] > best) { best = d[1] * d[2]; big = $2 } }
    END {
      s = ""
      if (SZ != "") { if (SZ in ok) s = SZ }
      else { n = split(WANT, w, " "); for (i = 1; i <= n; i++) if (w[i] in ok) { s = w[i]; break }
             if (s == "") s = big }
      if (s == "") exit 1
      f = FR
      if (f == "") f = (s in has30 || s in q) ? 30 : mx[s]
      print s, f
    }'
}

# The stable name for a node: /dev/videoN numbering moves between boots (on a Pi
# with a CSI camera too, unicam claims the first nodes), by-id does not.
stable_path() {
  local l
  for l in /dev/v4l/by-id/* /dev/v4l/by-path/*; do
    [ -e "$l" ] && [ "$(readlink -f "$l")" = "$1" ] && { echo "$l"; return; }
  done
  echo "$1"
}

capture_cmd() { # dev size fps
  echo "ffmpeg -loglevel error -f v4l2 -input_format h264 -video_size $2 -framerate $3 -i $1 -c copy -an ${FRAG_FLAGS} -f mp4 -"
}

# Sets H_DEV / H_FMTS to the UVC node offering H.264 (preferring one with 4K).
# H.264 is often on a second node, not the first one the camera creates.
find_h264_node() {
  local d f pass
  H_DEV=""; H_FMTS=""
  for pass in 4k any; do
    for d in ${DEV:-$(uvc_nodes)}; do
      f="$(formats_of "$d")"
      grep -q '^H264 ' <<<"$f" || continue
      [ "$pass" = 4k ] && ! grep -q '^H264 3840x2160 ' <<<"$f" && continue
      H_DEV="$d"; H_FMTS="$f"; return 0
    done
  done
  return 1
}

if [ -n "$DEV" ]; then
  [ -e "$DEV" ] || { echo "!! ${DEV} does not exist" >&2; exit 1; }
  DEV="$(readlink -f "$DEV")"
fi

# ---------------------------------------------------------------- --detect ---
# One line, the CAPTURE_CMD for this camera, or nothing and exit 1. Used by
# provision-pi.sh, so it prints nothing else.
if [ "$MODE" = detect ]; then
  find_h264_node || exit 1
  read -r S F <<<"$(pick_mode H264 <<<"$H_FMTS")" || exit 1
  [ -n "${S:-}" ] || exit 1
  # Only a camera at least as good as the CSI one may displace it.
  [ "${S%%x*}" -ge 1920 ] 2>/dev/null || exit 1
  capture_cmd "$(stable_path "$H_DEV")" "$S" "${F:-30}"
  exit 0
fi

# ----------------------------------------------------------------- --focus ---
# Same principle as focus-meter.sh: at fixed quality a sharper frame compresses
# worse, so a bigger JPEG means more detail. The camera's own MJPEG frames are
# used as-is (-c copy), so the Pi decodes nothing and the score is per-frame cheap.
if [ "$MODE" = focus ]; then
  M_DEV=""
  for d in ${DEV:-$(uvc_nodes)}; do
    if formats_of "$d" | grep -q '^MJPG '; then M_DEV="$d"; break; fi
  done
  [ -n "$M_DEV" ] || { echo "!! no USB camera offering MJPEG found -- focus by eye from the bench frames instead" >&2; exit 1; }
  read -r S _ <<<"$(FPS="" pick_mode MJPG <<<"$(formats_of "$M_DEV")")"
  [ -n "${S:-}" ] || { echo "!! no MJPEG mode${SIZE:+ at ${SIZE}} on ${M_DEV}" >&2; exit 1; }
  TMP="$(mktemp -t focus.XXXXXX.jpg)"
  trap 'rm -f "$TMP"; echo; echo "stopped."' EXIT
  echo "Focus aid on ${M_DEV} at ${S}. Loosen the lens lock screw gently, turn the ring"
  echo "until the score PEAKS, back off past the peak and return to it, then lock the"
  echo "screw -- and re-check: tightening it can shift focus. Ctrl-C to stop."
  echo
  BEST=0
  while true; do
    if ffmpeg -hide_banner -nostdin -v error -f v4l2 -input_format mjpeg -video_size "$S" \
         -i "$M_DEV" -ss 0.7 -frames:v 1 -c:v copy -f mjpeg -y "$TMP" 2>/dev/null; then
      SZ="$(stat -c%s "$TMP")"
      [ "$SZ" -gt "$BEST" ] && BEST="$SZ"
      PCT=$(( SZ * 100 / (BEST > 0 ? BEST : 1) ))
      BAR="$(printf '%*s' $(( PCT / 3 )) '' | tr ' ' '#')"
      printf '\rscore %9d   best %9d   %3d%% %-34s' "$SZ" "$BEST" "$PCT" "$BAR"
    else
      printf '\rcapture failed -- camera unplugged, or in use by something else?%-20s' ''
      sleep 1
    fi
  done
fi

# ------------------------------------------------------------------ bench ----
OUT="${OUT:-$HOME/usb-cam-bench/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT" || { echo "!! cannot create ${OUT}" >&2; exit 1; }
exec > >(tee -a "$OUT/report.txt") 2>&1
TEE_PID=$!

PASS=0; WARN=0; FAIL=0; HARD=0; FF_PID=""
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; PASS=$((PASS+1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; WARN=$((WARN+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL+1)); }
hard() { bad "$@"; HARD=1; }
info() { printf '        %s\n' "$*"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
calc() { awk "BEGIN { printf \"$1\", $2 }"; }   # calc FORMAT EXPR  (no bc on Pi OS Lite)

finish() { # exit code
  printf '\n\033[1m%d passed, %d warnings, %d failed\033[0m   (report: %s/report.txt)\n' \
    "$PASS" "$WARN" "$FAIL" "$OUT"
  case "$1" in
    0) echo "VERDICT: meets the spec -- the camera encodes 4K H.264 itself. Now LOOK at the frame." ;;
    2) echo "VERDICT: the camera emits H.264, but misses the spec -- see the FAIL lines above." ;;
    *) echo "VERDICT: not usable as bought -- see the FAIL lines above and the fallbacks in court-setup." ;;
  esac
  exec 1>&- 2>&-
  wait "$TEE_PID" 2>/dev/null
  exit "$1"
}
cleanup() { if [ -n "$FF_PID" ]; then kill -KILL "$FF_PID" 2>/dev/null; fi; return 0; }
trap cleanup EXIT
trap 'echo; echo "interrupted"; cleanup; exit 130' INT TERM

printf '\033[1mUSB camera bench -- %s -- %s\033[0m\n' "$(hostname)" "$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "  board:  $(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)"
echo "  output: ${OUT}"

# ---------------------------------------------------------------- 1. find ----
hdr "1. Find the USB camera"
if have v4l2-ctl; then
  v4l2-ctl --list-devices 2>/dev/null | sed 's/^/    /'
else
  warn "v4l2-ctl missing (package v4l-utils) -- using ffmpeg's listing instead; camera controls cannot be shown. Install: sudo apt-get install -y v4l-utils"
fi
NODES="${DEV:-$(uvc_nodes)}"
if [ -z "$NODES" ]; then
  hard "no USB (UVC) video device found. Replug the camera (try a blue USB 3 port), then: sudo dmesg | tail -20"
  finish 1
fi
for d in $NODES; do
  s="/sys/class/video4linux/$(basename "$d")"
  spd="$(cat "$(dirname "$(readlink -f "$s/device")")/speed" 2>/dev/null || echo '?')"
  echo "  ${d}  \"$(cat "$s/name" 2>/dev/null)\"  USB link ${spd} Mbit/s  ->  $(stable_path "$d")"
  formats_of "$d" | awk '{ m[$1] = m[$1] " " $2 "@" $3 } END { for (f in m) printf "        %s:%s\n", f, m[f] }'
  [ "$spd" = 12 ] && warn "${d} is on a USB 1.1 (12 Mbit/s) link -- bad cable or hub. Plug it straight into the Pi."
done

# ------------------------------------------------------------- 2. formats ----
hdr "2. Does the camera itself offer H.264?"
if ! find_h264_node; then
  hard "the camera offers NO H.264 on any node. Then the Pi would have to encode, which is what it cannot do at 4K (Pi 4 encoder stops at 1920 px; Pi 5 has none). MJPEG is not a substitute -- see court-setup 'If H.264 is missing'."
  finish 1
fi
STABLE="$(stable_path "$H_DEV")"
echo "  H.264 node: ${H_DEV}  (stable name: ${STABLE})"
echo "  H.264 modes:"
grep '^H264 ' <<<"$H_FMTS" | awk '{ printf "        %s @ %s fps\n", $2, $3 }'
K4="$(awk '$1=="H264" && $2=="3840x2160" { print $3 }' <<<"$H_FMTS" | sort -g | tail -1)"
if [ -n "$K4" ]; then
  if [ "$K4" = "?" ] || awk -v f="$K4" -v m="$MIN_FPS" 'BEGIN { exit !(f >= m) }'; then
    ok "H.264 at 3840x2160 offered (${K4} fps listed)"
  else
    bad "H.264 at 3840x2160 is offered only at ${K4} fps -- under the ${MIN_FPS} fps requirement"
  fi
else
  bad "H.264 is NOT offered at 3840x2160 -- the reason this camera was bought. Benchmarking the best H.264 mode that is offered instead."
fi
if ! read -r SZ FR <<<"$(pick_mode H264 <<<"$H_FMTS")" || [ -z "${SZ:-}" ]; then
  hard "requested size ${SIZE:-?} is not offered as H.264 by this camera"
  finish 1
fi
FR="${FR:-30}"
echo "  benchmarking: ${SZ} @ ${FR} fps"

# ------------------------------------------------------------ 3. controls ----
hdr "3. Camera controls (bitrate / GOP / exposure)"
if have v4l2-ctl; then
  CTRLS="$(v4l2-ctl -d "$H_DEV" -l 2>/dev/null)"
  [ -n "$CTRLS" ] && sed 's/^/    /' <<<"$CTRLS" || info "(no controls listed on ${H_DEV})"
  BG="$(grep -iE 'bitrate|bit_rate|gop|i_frame|idr|h264' <<<"$CTRLS" | awk '{ print $1 }' | tr '\n' ' ')"
  if [ -n "$BG" ]; then
    info "Bitrate/GOP controls exposed: ${BG}-- these can tune bitrate to the uplink."
  else
    info "No bitrate/GOP control exposed: bitrate and keyframe interval are whatever the"
    info "camera firmware chooses. Measured below; they cannot be changed from the Pi."
  fi
else
  info "(skipped -- v4l-utils not installed)"
fi

# -------------------------------------------------------------- 4. record ----
hdr "4. Record ${SECS} s of H.264, copied (-c copy) into the agent's fragmented MP4"
HOLDERS=""
for f in /proc/[0-9]*/fd/*; do
  [ "$(readlink "$f" 2>/dev/null)" = "$H_DEV" ] && HOLDERS="${HOLDERS} $(cut -d/ -f3 <<<"$f")"
done
if [ -n "$HOLDERS" ]; then
  warn "${H_DEV} is already open by PID(s)${HOLDERS} ($(ps -o comm= -p "$(awk '{print $1}' <<<"$HOLDERS")" 2>/dev/null)). The camera is single-access; if the agent is using it: sudo systemctl stop padel-agent"
fi
FREE_MB="$(df -Pm "$OUT" | awk 'NR==2 { print $4 }')"
if [ "${FREE_MB:-0}" -lt 1500 ]; then
  hard "only ${FREE_MB} MB free under ${OUT} -- need ~1.5 GB for ${SECS} s of 4K. Free some space."
  finish 1
fi

CMD="ffmpeg -hide_banner -nostdin -loglevel warning -f v4l2 -input_format h264 -video_size ${SZ} -framerate ${FR} -i ${H_DEV} -c copy -an ${FRAG_FLAGS} -f mp4 -"
echo "  ${CMD} > bench.mp4"
cpu_snap()   { awk '/^cpu / { t = 0; for (i = 2; i <= NF; i++) t += $i; print t, $5 + $6 }' /proc/stat; }
proc_ticks() { awk '{ print $14 + $15 }' "/proc/$1/stat" 2>/dev/null; }
TCK="$(getconf CLK_TCK 2>/dev/null || echo 100)"

# shellcheck disable=SC2086  # CMD is word-split on purpose; it holds no quoted args
$CMD >"$OUT/bench.mp4" 2>"$OUT/ffmpeg.log" &
FF_PID=$!
T_START="$(date +%s)"; C0=""; EARLY=0; EL=0
while :; do
  EL=$(( $(date +%s) - T_START ))
  if ! kill -0 "$FF_PID" 2>/dev/null; then EARLY=1; break; fi
  [ "$EL" -ge "$SECS" ] && break
  if [ -z "$C0" ] && [ "$EL" -ge 3 ]; then   # skip startup: measure steady state
    C0="$(cpu_snap)"; P0="$(proc_ticks "$FF_PID")"; W0="$(date +%s%N)"
  fi
  B="$(stat -c%s "$OUT/bench.mp4" 2>/dev/null || echo 0)"
  printf '\r  recording %3d s / %d s   %7s MB written   ~%5s Mbit/s so far ' \
    "$EL" "$SECS" "$(calc '%.1f' "$B/1048576")" "$(calc '%.1f' "($EL>0)?$B*8/$EL/1e6:0")"
  sleep 1
done
echo
if [ -n "$C0" ] && [ "$EARLY" = 0 ]; then
  C1="$(cpu_snap)"; P1="$(proc_ticks "$FF_PID")"; W1="$(date +%s%N)"
fi

if [ "$EARLY" = 1 ]; then
  wait "$FF_PID"; RCF=$?; FF_PID=""
  ERR="$(grep -iE 'error|fail|busy|invalid|not supported|cannot|no such' "$OUT/ffmpeg.log" | head -5)"
  [ -n "$ERR" ] || ERR="$(tail -5 "$OUT/ffmpeg.log")"
  hard "ffmpeg stopped by itself after ${EL} s (exit ${RCF}). Its words:"
  sed 's/^/          /' <<<"$ERR"
  grep -qi busy "$OUT/ffmpeg.log" && info "-> something else holds the camera. Stop it (sudo systemctl stop padel-agent, or a preview) and re-run."
  finish 1
fi

# Stop it the way the agent does: SIGINT so ffmpeg flushes the trailing fragment,
# then escalate after 4 s.
kill -INT "$FF_PID" 2>/dev/null
STOPPED_BY=SIGINT
for _ in 1 2 3 4 5 6 7 8; do kill -0 "$FF_PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$FF_PID" 2>/dev/null; then kill -TERM "$FF_PID" 2>/dev/null; STOPPED_BY=SIGTERM; sleep 2; fi
if kill -0 "$FF_PID" 2>/dev/null; then kill -KILL "$FF_PID" 2>/dev/null; STOPPED_BY=SIGKILL; fi
wait "$FF_PID" 2>/dev/null; FF_PID=""
info "ffmpeg stopped on ${STOPPED_BY}"
[ "$STOPPED_BY" = SIGKILL ] && warn "ffmpeg ignored SIGINT and SIGTERM -- the trailing fragment may be lost (the agent relies on SIGINT)"

# ------------------------------------------------------------- 5. measure ----
hdr "5. What the camera actually delivered"
F="$OUT/bench.mp4"
BYTES="$(stat -c%s "$F" 2>/dev/null || echo 0)"
echo "  file: ${BYTES} bytes"
ffprobe -v error -show_entries stream=index,codec_type,codec_name,profile,level,width,height,pix_fmt \
  -of compact=p=0 "$F" 2>/dev/null | sed 's/^/    /'
VCODEC="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$F" 2>/dev/null)"
NAUDIO="$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$F" 2>/dev/null | grep -c .)"

if [ "$VCODEC" != h264 ]; then
  hard "the output is not an H.264 video stream (got '${VCODEC:-nothing}', ${BYTES} bytes)"
  finish 1
fi
ok "H.264 straight from the camera's own node, written with -c copy: the camera encodes, the Pi only copies"

ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0 "$F" \
  >"$OUT/packets.csv" 2>/dev/null
# frames keyframes duration fps mean_gop max_gop
read -r NF NK DUR MFPS GOP MAXGOP <<<"$(awk -F, '
  $1 != "" && $1 != "N/A" {
    n++; t = $1 + 0
    if (n == 1 || t < lo) lo = t
    if (n == 1 || t > hi) hi = t
    if (index($2, "K")) { k++; if (k > 1) { g = t - pk; sum += g; if (g > mg) mg = g } pk = t }
  }
  END { d = hi - lo; printf "%d %d %.2f %.2f %.2f %.2f\n", n, k, d, (d > 0) ? (n - 1) / d : 0, (k > 1) ? sum / (k - 1) : 0, mg }' "$OUT/packets.csv")"

if [ "${NF:-0}" -lt 2 ] || [ "$(calc '%d' "${DUR:-0} > 0")" = 0 ]; then
  hard "only ${NF:-0} frames came out -- the camera produced (almost) no video"
  finish 1
fi
MBIT="$(calc '%.2f' "$BYTES*8/$DUR/1e6")"
echo "  ${NF} frames over ${DUR} s of media time (${EL} s wall clock incl. startup)"

if awk -v f="$MFPS" -v m="$MIN_FPS" 'BEGIN { exit !(f >= m) }'; then
  ok "frame rate ${MFPS} fps (requested ${FR}, need >= ${MIN_FPS})"
else
  bad "frame rate ${MFPS} fps -- under the ${MIN_FPS} fps requirement (requested ${FR}). Low light makes UVC cameras stretch exposure and drop fps: re-test in a bright room."
fi

if [ "${NK:-0}" -le 1 ]; then
  bad "only ${NK:-0} keyframe in ${DUR} s: the camera never repeats one. Players cannot seek, and a lost fragment would break the rest of the file."
elif awk -v g="$GOP" 'BEGIN { exit !(g <= 4) }'; then
  ok "keyframe every ${GOP} s on average (${NK} keyframes, longest gap ${MAXGOP} s)"
else
  warn "keyframe only every ${GOP} s on average (longest gap ${MAXGOP} s) -- coarse seeking; -frag_duration keeps uploads flowing regardless"
fi

if [ "${NAUDIO:-0}" -eq 0 ]; then
  ok "no audio stream in the output"
else
  warn "${NAUDIO} audio stream(s) in the output -- unexpected from a v4l2-only capture"
fi

GB90="$(calc '%.1f' "$MBIT*90*60/8/1000")"
echo "  average bitrate ${MBIT} Mbit/s  =  ${GB90} GB per 90-minute match"
if awk -v b="$MBIT" -v u="$UPLINK_MBIT" 'BEGIN { exit !(b <= 0.8 * u) }'; then
  ok "bitrate ${MBIT} Mbit/s fits the ~${UPLINK_MBIT} Mbit/s uplink with headroom -- video ready seconds after stop"
else
  LAG="$(calc '%.0f' "($MBIT/$UPLINK_MBIT - 1) * 90")"
  [ "$(calc '%d' "$LAG < 0")" = 1 ] && LAG=0
  warn "bitrate ${MBIT} Mbit/s vs ~${UPLINK_MBIT} Mbit/s uplink -- the spool absorbs it, but a 90-min match would be ready ~${LAG} min after stop, not seconds"
fi

if [ -n "${C1:-}" ]; then
  read -r T0 I0 <<<"$C0"; read -r T1 I1 <<<"$C1"
  SYS="$(calc '%.0f' "100*(($T1-$T0)-($I1-$I0))/(($T1-$T0)>0?($T1-$T0):1)")"
  FFC="$(calc '%.0f' "100*(${P1:-0}-${P0:-0})/$TCK/(($W1-$W0)/1e9)")"
  if [ "$FFC" -le 15 ]; then
    ok "CPU during capture: ffmpeg ${FFC}% of one core, whole Pi ${SYS}% busy -- nothing is being encoded here"
  else
    warn "CPU during capture: ffmpeg ${FFC}% of one core, whole Pi ${SYS}% busy -- higher than a pure copy should need"
  fi
else
  info "(CPU not sampled -- recording shorter than 4 s)"
fi
THR="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
case "$THR" in
  0x0) ok "no undervoltage or throttling (the camera draws from the Pi's USB)" ;;
  "")  info "(vcgencmd unavailable -- throttling not checked)" ;;
  *)   warn "throttling flags ${THR} -- the PSU may not carry the Pi plus the camera" ;;
esac

NWARN="$(grep -c . "$OUT/ffmpeg.log" 2>/dev/null)"; NWARN="${NWARN:-0}"
if [ "$NWARN" -gt 0 ]; then
  info "ffmpeg logged ${NWARN} warning line(s) while recording; first few:"
  sort "$OUT/ffmpeg.log" | uniq -c | sort -rn | head -5 | sed 's/^/          /'
fi

echo "  decoding the first 10 s to prove the file plays (about a minute on a Pi 4)..."
DECERR="$(ffmpeg -hide_banner -nostdin -v error -t 10 -i "$F" -f null - 2>&1 | head -5)"
if [ -z "$DECERR" ]; then
  ok "first 10 s decode with zero errors"
else
  warn "decode errors in the first 10 s:"; sed 's/^/          /' <<<"$DECERR"
fi

# --------------------------------------------------------------- 6. frame ----
hdr "6. A frame for a human to look at"
SS=5; [ "$(calc '%d' "$DUR < 7")" = 1 ] && SS=0
ffmpeg -hide_banner -nostdin -v error -ss "$SS" -i "$F" -frames:v 1 -q:v 2 -y "$OUT/frame-full.jpg"
ffmpeg -hide_banner -nostdin -v error -ss "$SS" -i "$F" -frames:v 1 -vf 'crop=iw/3:ih/3' -q:v 2 -y "$OUT/frame-centre-1to1.jpg"
if [ -s "$OUT/frame-full.jpg" ]; then
  ok "saved $(ffprobe -v error -show_entries stream=width,height -of csv=p=0:s=x "$OUT/frame-full.jpg") frame"
  info "${OUT}/frame-full.jpg         coverage: both back glasses and side walls in frame?"
  info "${OUT}/frame-centre-1to1.jpg  focus, 1:1 crop of the centre: far net/fence crisp?"
  info "LOOK AT BOTH before calling this camera good. If you ran this on the Pi, on your Mac:"
  info "  scp '$(id -un)@$(hostname):${OUT}/*.jpg' . && open frame-full.jpg frame-centre-1to1.jpg"
  info "Soft? Run with --focus and turn the lens ring until the score peaks."
else
  bad "could not extract a frame from the recording"
fi

# ------------------------------------------------------------ 7. command ----
hdr "7. CAPTURE_CMD for this camera (padel-agent.env; keep the double quotes)"
echo "CAPTURE_CMD=\"$(capture_cmd "$STABLE" "$SZ" "$FR")\""

if [ "$HARD" = 1 ]; then finish 1; elif [ "$FAIL" -gt 0 ]; then finish 2; else finish 0; fi
