#!/usr/bin/env bash
# Runs on YOUR laptop (not the Pi). Takes a freshly-flashed, SSH-enabled Pi that's
# booted on your LAN and brings it all the way up: installs your SSH key, copies the
# repo, and runs provision-pi.sh (deps + Tailscale SSH + camera agent) on the Pi.
#
# Usage:
#   cp .fleet.env.example .fleet.env      # fill in shared secrets once
#   ./setup-pi.sh <COURT_ID> <PI_HOST> [PI_USER]
# e.g.
#   ./setup-pi.sh court-1 raspberrypi.local
#
# Do Pis one at a time if they share the same hostname (raspberrypi.local), or set a
# unique hostname per card in Raspberry Pi Imager.

set -euo pipefail

COURT_ID="${1:?usage: setup-pi.sh <court-id> <pi-host> [pi-user]}"
PI_HOST="${2:?usage: setup-pi.sh <court-id> <pi-host> [pi-user]}"
PI_USER="${3:-pi}"
TARGET="${PI_USER}@${PI_HOST}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FLEET_ENV="${SCRIPT_DIR}/.fleet.env"

[ -f "${FLEET_ENV}" ] || {
  echo "Missing ${FLEET_ENV}. Run: cp ${SCRIPT_DIR}/.fleet.env.example ${FLEET_ENV}" >&2
  exit 1
}
# shellcheck disable=SC1090
set -a; . "${FLEET_ENV}"; set +a
: "${TS_AUTHKEY:?set TS_AUTHKEY in .fleet.env}"
: "${BACKEND:?set BACKEND in .fleet.env}"

echo "==> Waiting for ${TARGET} on the LAN (Ctrl-C to abort)…"
until ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "${TARGET}" true 2>/dev/null; do
  # If key auth isn't set up yet, install the key (prompts for the Pi password once).
  if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "${TARGET}" true 2>/dev/null; then
    if command -v ssh-copy-id >/dev/null; then
      echo "==> Installing your SSH key on ${TARGET}"
      ssh-copy-id "${TARGET}" && break || true
    fi
  fi
  sleep 3
done
echo "==> SSH to ${TARGET} OK"

echo "==> Syncing repo → ${TARGET}:~/padel-recording"
# Basename excludes (no slash) match at any depth and are protected from --delete,
# so the Pi's own padel-agent.env (with your CAPTURE_CMD) and node_modules survive re-runs.
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .wrangler \
  --exclude 'terraform/.terraform' --exclude '*.tfstate*' \
  --exclude '.dev.vars' --exclude '.fleet.env' --exclude 'padel-agent.env' \
  "${REPO_ROOT}/" "${TARGET}:padel-recording/"

# What this Pi is about to run. The agent used to report a hand-edited date
# constant, so two Pis on different code could both claim the same version and
# the fleet listing lied. `-dirty` is deliberate: deploying an uncommitted tree
# is exactly the case you most need to see in the version column.
AGENT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if ! git -C "${REPO_ROOT}" diff --quiet HEAD 2>/dev/null; then
  AGENT_SHA="${AGENT_SHA}-dirty"
fi
echo "==> Deploying agent ${AGENT_SHA}"

echo "==> Provisioning on ${TARGET} (Tailscale SSH + agent)…"
ssh -t "${TARGET}" \
  "sudo COURT_ID='${COURT_ID}' TS_AUTHKEY='${TS_AUTHKEY}' BACKEND='${BACKEND}' \
        DEVICE_TOKEN='${DEVICE_TOKEN:-}' PART_SIZE_MB='${PART_SIZE_MB:-5}' RUN_USER='${PI_USER}' \
        CAMERA_OVERLAY='${CAMERA_OVERLAY:-}' AGENT_SHA='${AGENT_SHA}' \
        bash padel-recording/agent/deploy/provision-pi.sh"

echo
echo "==> ${COURT_ID} is up. From now on, reach it over Tailscale:  ssh ${PI_USER}@${COURT_ID}"
echo "    (Review CAPTURE_CMD on the Pi: ~/padel-recording/agent/deploy/padel-agent.env)"
