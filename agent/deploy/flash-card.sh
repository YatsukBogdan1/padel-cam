#!/usr/bin/env bash
# Runs on YOUR MAC. Blank SD card -> fully provisioned court camera, one command.
#
#   ./agent/deploy/flash-card.sh <court-id> [disk] [image.img.xz|url]
#
# It writes Raspberry Pi OS Lite with a first-boot script that sets the hostname and
# preloads every WiFi network the Pi will ever need (home, venue 5 GHz, venue 2.4 GHz,
# your phone hotspot), then waits for the Pi on your LAN and hands off to setup-pi.sh.
#
# You never open Raspberry Pi Imager, and you never configure anything on the Pi
# itself. Because the venue WiFi is baked in at flash time, the Pi will also join it
# unaided the first time it boots at the court.
#
# Requires: Raspberry Pi Imager installed (for its CLI). Passphrases are prompted,
# never taken from argv, and never written to the repo.

set -euo pipefail

# Resolve every disk the OS is running from, so we can never offer one.
ROOT_WHOLE="$(diskutil info / 2>/dev/null | sed -n 's/^ *Part of Whole: *//p' | head -1)"
ROOT_STORE="$(diskutil info / 2>/dev/null | sed -n 's/^ *APFS Physical Store: *//p' | head -1)"
ROOT_PHYS="$(printf '%s' "$ROOT_STORE" | sed 's/s[0-9]*$//')"

# "|" as the delimiter: diskutil field names contain "/" (Device / Media Name).
disk_field() { sed -n "s|^ *$2: *||p" <<<"$1" | head -1; }

is_protected() {
  [ -n "$ROOT_WHOLE" ] && [ "$1" = "$ROOT_WHOLE" ] && return 0
  [ -n "$ROOT_PHYS"  ] && [ "$1" = "$ROOT_PHYS"  ] && return 0
  return 1
}

# Eligible = whole disk, removable/ejectable, not virtual, not backing the system.
disk_eligible() {
  local info="$1" ident="$2"
  [ "$(disk_field "$info" 'Whole')" = "Yes" ] || return 1
  [ "$(disk_field "$info" 'Virtual')" = "Yes" ] && return 1
  local rem ejc
  rem="$(disk_field "$info" 'Removable Media')"
  ejc="$(disk_field "$info" 'Ejectable')"
  case "$rem$ejc" in *Removable*|*Yes*) ;; *) return 1 ;; esac
  is_protected "$ident" && return 1
  return 0
}

# Volume names already on a disk — the best "is this really the right card?" signal.
# `diskutil list` is fixed-width, not whitespace-delimited, so ask about each
# partition individually rather than slicing columns.
disk_volumes() {
  local d="$1" out="" part n
  for part in $(diskutil list "/dev/$d" 2>/dev/null \
                | sed -n "s|.*[[:space:]]\(${d}s[0-9][0-9]*\)\$|\1|p"); do
    n="$(diskutil info "/dev/$part" 2>/dev/null | sed -n 's|^ *Volume Name: *||p' | head -1)"
    case "$n" in ''|'Not applicable'*) continue ;; esac
    out="${out}${out:+, }${n}"
  done
  printf '%s' "$out"
}

list_candidates() {
  printf '    %-7s %-11s %-24s %-16s %s\n' DISK SIZE MEDIA PROTOCOL VOLUMES
  diskutil list physical 2>/dev/null | sed -n 's|^/dev/\(disk[0-9]*\) .*|\1|p' | while read -r d; do
    local info; info="$(diskutil info "/dev/$d" 2>/dev/null)" || continue
    disk_eligible "$info" "$d" || continue
    local size media proto vols
    size="$(disk_field "$info" 'Disk Size' | sed 's/ (.*//')"
    media="$(disk_field "$info" 'Device / Media Name')"
    proto="$(disk_field "$info" 'Protocol')"
    vols="$(disk_volumes "$d")"
    printf '    %-7s %-11s %-24s %-16s %s\n' "$d" "$size" "$media" "$proto" "${vols:-<empty>}"
  done
}

# `--list` answers "which one is my card?" without touching anything.
if [ "${1:-}" = "--list" ]; then
  echo "Disks that can be written to (whole, removable, not your system disk):"
  echo
  list_candidates
  echo
  echo "Your system disks (${ROOT_WHOLE}, ${ROOT_PHYS}) are excluded and can never be selected."
  exit 0
fi


# --no-erase skips the pre-wipe. The image write replaces the whole disk either
# way; erasing first just guarantees a deterministic starting state.
ERASE=1
ARGS=()
for a in "$@"; do
  case "$a" in
    --no-erase) ERASE=0 ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

COURT_ID="${1:?usage: flash-card.sh [--no-erase] <court-id> [disk] [image|url]}"
DISK="${2:-}"
IMAGE="${3:-https://downloads.raspberrypi.com/raspios_lite_arm64_latest}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ENV="${SCRIPT_DIR}/.fleet.env"
IMAGER="/Applications/Raspberry Pi Imager.app/Contents/MacOS/rpi-imager"

[ -x "$IMAGER" ] || { echo "!! Raspberry Pi Imager not found at ${IMAGER}" >&2; exit 1; }
[ -f "$FLEET_ENV" ] || { echo "!! Missing ${FLEET_ENV} — cp .fleet.env.example .fleet.env" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$FLEET_ENV"; set +a

PI_USER="${PI_USER:-pi}"
WIFI_COUNTRY="${WIFI_COUNTRY:?set WIFI_COUNTRY in .fleet.env (two-letter code, e.g. PT)}"

# ---------------------------------------------------------------- pick disk ----
# NOTE: "external" is the WRONG test on a Mac. A card in the built-in SDXC slot
# reports `Device Location: Internal` (Protocol: Secure Digital), so it never shows
# up under `diskutil list external`. What actually makes a disk safe to erase is:
# it is a whole disk, it is removable, and it is not backing the running system.

if [ -z "$DISK" ]; then
  echo "==> Disks that can be written to (whole, removable, not your system disk):"
  echo
  list_candidates
  echo
  read -rp "Which disk is the SD card? (e.g. disk4, or Enter to abort): " DISK
  [ -n "$DISK" ] || { echo "aborted."; exit 1; }
fi
DISK="${DISK#/dev/}"

INFO="$(diskutil info "/dev/$DISK" 2>/dev/null)" || { echo "!! /dev/$DISK not found" >&2; exit 1; }

if is_protected "$DISK"; then
  echo "!! /dev/$DISK is backing the running system. Absolutely refusing." >&2; exit 1
fi
if ! disk_eligible "$INFO" "$DISK"; then
  echo "!! /dev/$DISK is not a whole removable disk. Refusing." >&2
  echo "   Eligible disks:" >&2; list_candidates >&2
  exit 1
fi

SIZE="$(disk_field "$INFO" 'Disk Size' | sed 's/ (.*//')"
NAME="$(disk_field "$INFO" 'Device / Media Name')"
LOCATION="$(disk_field "$INFO" 'Device Location')"
EXISTING="$(disk_volumes "$DISK")"

# Show exactly which networks will be baked in. An SSID lost to a missing quote in
# .fleet.env silently becomes empty and gets skipped — this is where you catch that,
# rather than at a venue with no way to reach the Pi.
net_line() {  # net_line <label> <ssid> <priority>
  if [ -n "$2" ]; then printf '    %-14s %-28s priority %s\n' "$1" "$2" "$3"
  else                 printf '    %-14s %s\n' "$1" "(none — check quoting in .fleet.env)"; fi
}

if [ "$ERASE" = "1" ]; then ERASE_LABEL="full erase, then write image"; else ERASE_LABEL="write image only (--no-erase)"; fi

cat <<EOF

  ================= THIS ERASES THE DISK COMPLETELY =================
    Disk:   /dev/${DISK}
    Media:  ${NAME}
    Size:   ${SIZE}
    Reader: ${LOCATION} (${DISK})
    Erasing: ${EXISTING:-<no existing volumes>}
    Wipe:   ${ERASE_LABEL}
    Court:  ${COURT_ID}
    User:   ${PI_USER}
    Region: ${WIFI_COUNTRY}
  -------------------- WiFi baked into the card ---------------------
EOF
net_line "home"      "${HOME_SSID:-}"      40
net_line "venue 5G"  "${VENUE_SSID_5G:-}"  20
net_line "venue 2.4" "${VENUE_SSID_24:-}"  10
net_line "hotspot"   "${HOTSPOT_SSID:-}"    1
cat <<EOF
  ===================================================================
    An SSID with a space or apostrophe MUST be quoted in .fleet.env:
        HOTSPOT_SSID="Sam's iPhone"
    Unquoted, it silently becomes empty and is skipped.

EOF
if [ -z "${HOTSPOT_SSID:-}" ] && [ -z "${VENUE_SSID_5G:-}" ]; then
  echo "  !! Neither a hotspot nor a venue network is set. This Pi will only ever"
  echo "     come online on your home WiFi — you will not be able to reach it"
  echo "     anywhere else. Ctrl-C now unless that is what you want."
  echo
fi
read -rp "Type '${DISK}' to confirm, anything else aborts: " CONFIRM
[ "$CONFIRM" = "$DISK" ] || { echo "aborted."; exit 1; }

# ------------------------------------------------------------- credentials ----
ask_psk() {  # ask_psk <var-name> <ssid-label>
  local __var="$1" __label="$2" __val
  printf 'Passphrase for %s (blank to skip): ' "$__label" >&2
  read -rs __val; echo >&2
  printf -v "$__var" '%s' "$__val"
}

printf 'Password for the "%s" user on the Pi (hidden): ' "$PI_USER" >&2
read -rs PI_PASS; echo >&2
[ -n "$PI_PASS" ] || { echo "!! password required" >&2; exit 1; }
PI_HASH="$(openssl passwd -6 "$PI_PASS")"
unset PI_PASS

[ -n "${HOME_SSID:-}"      ] && ask_psk HOME_PSK      "$HOME_SSID (home, for bench setup)"
[ -n "${VENUE_SSID_5G:-}"  ] && ask_psk VENUE_PSK_5G  "$VENUE_SSID_5G (venue 5 GHz)"
[ -n "${VENUE_SSID_24:-}"  ] && ask_psk VENUE_PSK_24  "$VENUE_SSID_24 (venue 2.4 GHz)"
[ -n "${HOTSPOT_SSID:-}"   ] && ask_psk HOTSPOT_PSK   "$HOTSPOT_SSID (phone hotspot, recovery)"

# --------------------------------------------------------- first-run script ----
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FIRSTRUN="${WORK}/firstrun.sh"

# NetworkManager keyfiles are written directly rather than shelling out to nmcli:
# firstrun.sh runs before NetworkManager is necessarily up, and NM picks up keyfiles
# on start regardless. Priority order matters — see the skill: 5 GHz above 2.4 GHz,
# hotspot last as recovery.
emit_wifi() {  # emit_wifi <ssid> <psk> <priority>
  local ssid="$1" psk="$2" prio="$3"
  [ -n "$ssid" ] && [ -n "$psk" ] || return 0
  cat <<EOF
cat > "/etc/NetworkManager/system-connections/${ssid}.nmconnection" <<'NMEOF'
[connection]
id=${ssid}
type=wifi
autoconnect=true
autoconnect-priority=${prio}
[wifi]
mode=infrastructure
ssid=${ssid}
powersave=2
cloned-mac-address=permanent
[wifi-security]
key-mgmt=wpa-psk
psk=${psk}
[ipv4]
method=auto
[ipv6]
method=auto
NMEOF
chmod 600 "/etc/NetworkManager/system-connections/${ssid}.nmconnection"
EOF
}

{
  echo '#!/bin/bash'
  echo 'set +e'
  echo ''
  echo '# Hostname — this becomes the tailnet name you SSH to forever after.'
  echo "CURRENT_HOSTNAME=\$(tr -d ' \\t\\n\\r' < /etc/hostname)"
  echo "if [ -f /usr/lib/raspberrypi-sys-mods/imager_custom ]; then"
  echo "  /usr/lib/raspberrypi-sys-mods/imager_custom set_hostname ${COURT_ID}"
  echo "else"
  echo "  echo ${COURT_ID} > /etc/hostname"
  echo "  sed -i \"s/127.0.1.1.*\$CURRENT_HOSTNAME/127.0.1.1\\t${COURT_ID}/g\" /etc/hosts"
  echo "fi"
  echo ''
  echo '# WiFi regulatory domain must be set or 5 GHz channels stay invisible.'
  echo "raspi-config nonint do_wifi_country ${WIFI_COUNTRY}"
  echo ''
  emit_wifi "${HOME_SSID:-}"     "${HOME_PSK:-}"     40
  emit_wifi "${VENUE_SSID_5G:-}" "${VENUE_PSK_5G:-}" 20
  emit_wifi "${VENUE_SSID_24:-}" "${VENUE_PSK_24:-}" 10
  emit_wifi "${HOTSPOT_SSID:-}"  "${HOTSPOT_PSK:-}"  1
  echo ''
  echo '# Remove ourselves and the cmdline hook so this runs exactly once.'
  echo 'rm -f /boot/firmware/firstrun.sh'
  echo "sed -i 's| systemd.run.*||g' /boot/firmware/cmdline.txt"
  echo 'exit 0'
} > "$FIRSTRUN"
chmod +x "$FIRSTRUN"

# ------------------------------------------------------------------- write ----
# macOS auto-mounts any readable volume on the card, and writing to the raw device
# fails with "Resource busy" while one is mounted. Always unmount first.
echo
echo "==> Unmounting /dev/${DISK}"
diskutil unmountDisk force "/dev/$DISK"

if [ "$ERASE" = "1" ]; then
  # Belt-and-braces: the image write below replaces the partition table anyway.
  # Erasing first clears any previous Pi layout (whose ext4 root macOS keeps
  # trying to mount mid-write) and leaves a known-good starting state.
  echo "==> Erasing /dev/${DISK}"
  diskutil eraseDisk FAT32 PIBOOT MBRFormat "/dev/$DISK"
  diskutil unmountDisk force "/dev/$DISK"
fi

echo
echo "==> Writing ${IMAGE}"
echo "    to /dev/${DISK} (sudo — writing to a raw device needs root)"

# A card in the Mac's built-in SDXC slot reports Device Location: Internal, and
# rpi-imager refuses "system drives" for that reason. Our own guards have already
# established this is a whole, removable disk that is NOT backing the running
# system, and the operator has typed the disk name to confirm — so the override is
# safe HERE specifically, and is passed only for an internal reader.
IMAGER_ARGS=(--cli "$IMAGE" "/dev/$DISK" --first-run-script "$FIRSTRUN" --disable-eject)
if [ "$LOCATION" = "Internal" ]; then
  echo "    (built-in card reader reports as internal; allowing it explicitly)"
  IMAGER_ARGS+=(--enable-writing-system-drives)
fi
sudo "$IMAGER" "${IMAGER_ARGS[@]}"

# --------------------------------------------------- user account + ssh on ----
# userconf.txt and the `ssh` marker are the documented boot-partition mechanisms.
# They are handled natively by the OS, so they need no cmdline wiring and cannot
# clash with the first-run script above.
echo "==> Waiting for the boot partition to mount…"
BOOTFS=""
for _ in $(seq 1 30); do
  for cand in /Volumes/bootfs /Volumes/boot; do
    [ -d "$cand" ] && { BOOTFS="$cand"; break 2; }
  done
  sleep 1
done
if [ -n "$BOOTFS" ]; then
  printf '%s:%s\n' "$PI_USER" "$PI_HASH" > "${BOOTFS}/userconf.txt"
  touch "${BOOTFS}/ssh"
  echo "==> Created user '${PI_USER}' and enabled SSH"
  sync
  diskutil eject "/dev/$DISK" >/dev/null 2>&1 || true
else
  echo "!! Boot partition did not mount — re-insert the card and add manually:" >&2
  echo "   echo '${PI_USER}:<hash>' > /Volumes/bootfs/userconf.txt && touch /Volumes/bootfs/ssh" >&2
  exit 1
fi

cat <<EOF

==> Card ready.

    1. Put it in the Pi and power on. It joins WiFi by itself.
    2. First boot takes ~90s.

    Then provision (this waits for it to appear):

       ./agent/deploy/setup-pi.sh ${COURT_ID} ${COURT_ID}.local ${PI_USER}

EOF

read -rp "Run that now? [y/N] " GO
if [[ "$GO" =~ ^[Yy]$ ]]; then
  exec "${SCRIPT_DIR}/setup-pi.sh" "$COURT_ID" "${COURT_ID}.local" "$PI_USER"
fi
