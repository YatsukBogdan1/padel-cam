#!/usr/bin/env bash
# One-time preparation of a PREPRODUCTION camera so the e2e suite can inject
# faults on it. Run once per Pi; it prompts for the Pi's sudo password.
#
#   npm run e2e:setup
#
# What it grants, and why each is needed:
#
#   systemctl start/stop/restart padel-agent  — presence, stop-while-down, disk-budget
#   iptables -I/-D OUTPUT -d <ip> -j DROP     — cutting the Pi off from the Worker
#   reboot -f                                 — the real power-cut scenario
#
# Deliberately NOT blanket NOPASSWD. This account is reachable over Tailscale SSH
# from anywhere, so the rule names the exact verbs and nothing else.
#
# DO NOT run this against a camera at a paying venue. It exists so a home Pi can
# be broken on purpose.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# Read PI_HOST and SPOOL_DIR from e2e/.env unless already in the environment, so
# this cannot drift from what the suite itself will use.
read_env() { # key
  [ -f "${HERE}/.env" ] || return 0
  grep -E "^$1=" "${HERE}/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"''
}
PI_HOST="${PI_HOST:-$(read_env PI_HOST)}"
SPOOL_DIR="${SPOOL_DIR:-$(read_env SPOOL_DIR)}"
SPOOL_DIR="${SPOOL_DIR:-/var/lib/padel-agent/spool}"
: "${PI_HOST:?set PI_HOST, or create e2e/.env from .env.example}"

RUN_USER="${PI_HOST%%@*}"

echo "==> Preparing ${PI_HOST} as a preproduction test camera"
echo "      user:  ${RUN_USER}"
echo "      spool: ${SPOOL_DIR}"
echo
echo "    This grants scoped passwordless sudo for fault injection."
echo "    Do NOT run it against a camera at a paying venue."
echo
read -r -p "Continue? [y/N] " reply
case "$reply" in
  [yY]*) ;;
  *) echo "aborted"; exit 1 ;;
esac

echo "==> Installing sudoers rule (you will be prompted for the Pi's password)"
# Full paths throughout: /usr/sbin is not on the Pi's non-login PATH, and sudo
# matches the rule against the resolved command path.
ssh -t "$PI_HOST" "sudo sh -c '
  cat > /etc/sudoers.d/padel-e2e <<SUDOERS
# Installed by e2e/setup-pi.sh. Preproduction fault injection only.
${RUN_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl start padel-agent, /usr/bin/systemctl stop padel-agent, /usr/bin/systemctl restart padel-agent, /bin/systemctl start padel-agent, /bin/systemctl stop padel-agent, /bin/systemctl restart padel-agent
${RUN_USER} ALL=(root) NOPASSWD: /usr/sbin/iptables -I OUTPUT -d * -j DROP, /usr/sbin/iptables -D OUTPUT -d * -j DROP
${RUN_USER} ALL=(root) NOPASSWD: /usr/sbin/reboot -f, /sbin/reboot -f
SUDOERS
  chmod 0440 /etc/sudoers.d/padel-e2e
  if ! /usr/sbin/visudo -cf /etc/sudoers.d/padel-e2e >/dev/null; then
    echo \"!! sudoers rule rejected — removing it rather than leaving sudo broken\"
    rm -f /etc/sudoers.d/padel-e2e
    exit 1
  fi
  mkdir -p ${SPOOL_DIR}
  chown -R ${RUN_USER}:${RUN_USER} ${SPOOL_DIR}
  echo installed
'"

# `sudo -n -l <command>` asks whether it WOULD be permitted, without running it.
# Checking by execution would need commands the rule deliberately does not grant.
echo "==> Verifying (nothing is executed, only authorised)"
check() { # description, command...
  local desc="$1"; shift
  if ssh "$PI_HOST" "sudo -n -l $* >/dev/null 2>&1"; then
    echo "    ok       ${desc}"
  else
    echo "    MISSING  ${desc}"
    FAILED=1
  fi
}
FAILED=0
check "systemctl restart padel-agent" /usr/bin/systemctl restart padel-agent
check "systemctl stop padel-agent"    /usr/bin/systemctl stop padel-agent
check "iptables -I OUTPUT"            /usr/sbin/iptables -I OUTPUT -d 1.2.3.4 -j DROP
check "reboot -f"                     /usr/sbin/reboot -f
if ssh "$PI_HOST" "test -w ${SPOOL_DIR}"; then
  echo "    ok       spool writable"
else
  echo "    MISSING  spool ${SPOOL_DIR} not writable by ${RUN_USER}"
  FAILED=1
fi

echo
if [ "$FAILED" = "1" ]; then
  echo "==> Something is missing above. The suite will fail on the sudo scenarios."
  exit 1
fi
echo "==> Done. Run the full suite with:  npm run e2e -- --include-slow"
