#!/usr/bin/env bash
#
# File Expo — password reset (break-glass, run on the VPS)
#
# Use this when you forgot the web panel password. It rewrites the password
# hash directly in the config file, using the exact same hashing the server
# uses, then restarts the service.
#
#   sudo bash reset-password.sh                 # prompts for a new password
#   sudo bash reset-password.sh 'newpassword'   # non-interactive
#
# Or straight from GitHub, no clone needed:
#   curl -fsSL https://raw.githubusercontent.com/zamansheikh/file-expo/main/reset-password.sh | sudo bash
#
set -euo pipefail

CONF_DIR="${FILE_EXPO_CONF:-/etc/file-expo}"
CONF_FILE="$CONF_DIR/config.json"
SERVICE="file-expo"

# ── colors ───────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; N=$'\e[0m'; else B= G= R= Y= N=; fi
die() { echo "${R}error:${N} $*" >&2; exit 1; }

# ── checks ───────────────────────────────────────────────────
[ "$(id -u)" = "0" ] || die "run as root (use sudo)"
command -v node >/dev/null 2>&1 || die "node is not installed — File Expo needs it, is it installed here?"
[ -f "$CONF_FILE" ] || die "config not found at $CONF_FILE — is File Expo installed on this machine?"

# ── get the new password ─────────────────────────────────────
if [ "${1:-}" != "" ]; then
  NEWPASS="$1"
else
  # Read from the terminal, not stdin — so this works under `curl ... | sudo bash`,
  # where stdin is the piped script rather than the keyboard.
  [ -e /dev/tty ] || die "no password given and no terminal to prompt on — pass it as an argument: sudo bash reset-password.sh 'newpass'"
  printf "%s" "${B}New panel password (min 6 chars): ${N}" > /dev/tty
  read -rs NEWPASS < /dev/tty; echo > /dev/tty
  printf "%s" "${B}Confirm password: ${N}" > /dev/tty
  read -rs NEWPASS2 < /dev/tty; echo > /dev/tty
  [ "$NEWPASS" = "$NEWPASS2" ] || die "passwords do not match"
fi
[ "${#NEWPASS}" -ge 6 ] || die "password must be at least 6 characters"

# ── rewrite the hash with node (same crypto as server.js) ────
# scryptSync(pw, salt, 64) hex, with a fresh 16-byte hex salt.
CONF_FILE="$CONF_FILE" NEWPASS="$NEWPASS" node <<'NODE' || die "failed to update config"
const fs = require('fs');
const crypto = require('crypto');
const file = process.env.CONF_FILE;
const pw = process.env.NEWPASS;

const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
conf.salt = salt;
conf.passHash = crypto.scryptSync(pw, salt, 64).toString('hex');
conf.configured = true;      // in case it was never set up
conf.setupToken = null;      // invalidate any pending setup link

fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
NODE

echo "${G}✓${N} password updated in $CONF_FILE"

# ── restart so any cached sessions are dropped ───────────────
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^$SERVICE.service"; then
  systemctl restart "$SERVICE" && echo "${G}✓${N} restarted $SERVICE service"
else
  echo "${Y}!${N} no systemd '$SERVICE' service found — restart File Expo manually if it's running (e.g. pkill -f server/server.js)."
fi

echo
echo "${B}Done.${N} Log in with your new password."
