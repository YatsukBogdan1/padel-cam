#!/usr/bin/env bash
# Run ON THE PI. Join a venue WiFi network and apply the settings a court camera
# needs. The passphrase is prompted by nmcli — it never appears in argv, in shell
# history, or in any file you might commit.
#
# Usage (on the Pi):
#   sudo agent/deploy/connect-wifi.sh "Venue-SSID 5G" 20
#   sudo agent/deploy/connect-wifi.sh "Venue-SSID"    10
#
# Add the 5 GHz SSID at a HIGHER priority than the 2.4 GHz one. NetworkManager
# picks the highest-priority profile whose SSID is visible, and 2.4 reaches further,
# so this gives you speed when close and range when not.

set -euo pipefail

PRELOAD=0
if [ "${1:-}" = "--preload" ]; then PRELOAD=1; shift; fi

SSID="${1:?usage: sudo connect-wifi.sh [--preload] \"<SSID>\" [priority]}"
PRIORITY="${2:-10}"
IFACE="${IFACE:-wlan0}"

[ "$(id -u)" -eq 0 ] || { echo "!! run with sudo" >&2; exit 1; }

# --preload: save a profile for a network that is NOT in range, so the Pi joins it
# on its own the first time it boots at the venue. This is what removes the need for
# Ethernet, a USB tether or a monitor on site — do it at home, before you travel.
if [ "$PRELOAD" = "1" ]; then
  # `iw` is not installed on Raspberry Pi OS Lite — ask raspi-config instead.
  COUNTRY="$(raspi-config nonint get_wifi_country 2>/dev/null | tr -d "[:space:]")"
  [ -z "$COUNTRY" ] && COUNTRY="$(sudo -n raspi-config nonint get_wifi_country 2>/dev/null | tr -d "[:space:]")"
  if [ -z "$COUNTRY" ] || [ "$COUNTRY" = "00" ]; then
    echo "!! WiFi country is not set — 5 GHz channels stay invisible until it is." >&2
    echo "   sudo raspi-config nonint do_wifi_country XX   (the venue's country)" >&2
    exit 1
  fi
  if nmcli -t -f NAME connection show | grep -Fxq "$SSID"; then
    echo "==> Profile '${SSID}' already exists — updating priority only"
  else
    printf 'Passphrase for %s (hidden): ' "$SSID" >&2
    read -rs PSK; echo >&2
    [ -n "$PSK" ] || { echo "!! empty passphrase" >&2; exit 1; }
    # Note: the passphrase is briefly visible in `ps` on this machine while nmcli
    # runs. It never reaches shell history or any file in the repo.
    nmcli connection add type wifi con-name "$SSID" ifname "$IFACE" ssid "$SSID" -- \
      wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PSK" >/dev/null
    unset PSK
  fi
  nmcli connection modify "$SSID" \
    connection.autoconnect yes \
    connection.autoconnect-priority "$PRIORITY" \
    wifi.powersave 2 \
    802-11-wireless.cloned-mac-address permanent
  echo "==> Preloaded '${SSID}' at priority ${PRIORITY} (country ${COUNTRY})."
  echo "    UNVERIFIED until the Pi is actually at the venue — the passphrase and the"
  echo "    presence of a captive portal can only be confirmed there."
  exit 0
fi

echo "==> Scanning ${IFACE} for '${SSID}'"
nmcli device wifi rescan ifname "$IFACE" >/dev/null 2>&1 || true
sleep 3

if ! nmcli -t -f SSID device wifi list ifname "$IFACE" | grep -Fxq "$SSID"; then
  echo "!! '${SSID}' is not visible on ${IFACE}." >&2
  echo "   Networks in range right now:" >&2
  nmcli -f SSID,CHAN,SIGNAL,SECURITY device wifi list ifname "$IFACE" | head -12 >&2
  echo "   If a 5 GHz SSID is missing, check the WiFi country is set:" >&2
  echo "     sudo raspi-config nonint do_wifi_country XX" >&2
  exit 1
fi

if nmcli -t -f NAME connection show | grep -Fxq "$SSID"; then
  echo "==> Profile '${SSID}' already exists — reusing it"
else
  echo "==> Connecting. Type the passphrase at the prompt (input is hidden)."
  nmcli --ask device wifi connect "$SSID" ifname "$IFACE"
fi

echo "==> Applying court-camera settings"
# powersave 2 = disabled. WiFi power save stalls long uploads mid-recording.
# cloned-mac permanent = stable MAC, so venue MAC allow-lists keep working.
nmcli connection modify "$SSID" \
  connection.autoconnect yes \
  connection.autoconnect-priority "$PRIORITY" \
  wifi.powersave 2 \
  802-11-wireless.cloned-mac-address permanent

nmcli connection up "$SSID" ifname "$IFACE" >/dev/null

echo "==> Verifying internet ON ${IFACE} specifically"
# Scoped to the interface on purpose: if Ethernet is still plugged in it has the
# lower route metric, so an unscoped ping proves nothing about WiFi.
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 \
        --interface "$IFACE" http://connectivitycheck.gstatic.com/generate_204 || echo 000)"

case "$CODE" in
  204) echo "==> OK: real internet on ${IFACE}." ;;
  200|30[0-9])
    echo "!! CAPTIVE PORTAL (HTTP ${CODE}). The Pi cannot click through a login page." >&2
    echo "   Ask the venue for a staff/IoT SSID, or have them allow-list this MAC:" >&2
    nmcli -g GENERAL.HWADDR device show "$IFACE" >&2
    exit 2 ;;
  *)
    echo "!! No route out on ${IFACE} (code ${CODE})." >&2
    exit 3 ;;
esac

echo
echo "Saved WiFi profiles, highest priority first:"
nmcli -t -f NAME,TYPE,AUTOCONNECT-PRIORITY connection show \
  | awk -F: '$2=="802-11-wireless"{printf "  %-28s priority %s\n",$1,$3}' | sort -k3 -rn
