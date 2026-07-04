#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
#  File Expo — one-line server installer
#
#    curl -fsSL https://raw.githubusercontent.com/zamansheikh/file-expo/main/install.sh | sudo bash
#
#  Uninstall:
#    curl -fsSL https://raw.githubusercontent.com/zamansheikh/file-expo/main/install.sh | sudo bash -s -- --uninstall
# ══════════════════════════════════════════════════════════════
set -u

REPO="zamansheikh/file-expo"
BRANCH="main"
PORT="${FILE_EXPO_PORT:-7777}"
APP_DIR="/opt/file-expo"
CONF_DIR="/etc/file-expo"
SERVICE="file-expo"
LOG="/var/log/file-expo-install.log"

# colors
if [ -t 1 ] || [ -n "${FORCE_COLOR:-}" ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[34m'; C=$'\033[36m'; W=$'\033[97m'; D=$'\033[2m'; N=$'\033[0m'
else
  R=; G=; Y=; B=; C=; W=; D=; N=
fi

TOTAL=8
CURRENT=0

banner() {
  echo ""
  echo "${C}  ███████╗██╗██╗     ███████╗    ███████╗██╗  ██╗██████╗  ██████╗ ${N}"
  echo "${C}  ██╔════╝██║██║     ██╔════╝    ██╔════╝╚██╗██╔╝██╔══██╗██╔═══██╗${N}"
  echo "${C}  █████╗  ██║██║     █████╗      █████╗   ╚███╔╝ ██████╔╝██║   ██║${N}"
  echo "${C}  ██╔══╝  ██║██║     ██╔══╝      ██╔══╝   ██╔██╗ ██╔═══╝ ██║   ██║${N}"
  echo "${C}  ██║     ██║███████╗███████╗    ███████╗██╔╝ ██╗██║     ╚██████╔╝${N}"
  echo "${C}  ╚═╝     ╚═╝╚══════╝╚══════╝    ╚══════╝╚═╝  ╚═╝╚═╝      ╚═════╝ ${N}"
  echo "${D}  Web file manager for your server · https://github.com/$REPO${N}"
  echo ""
}

progress_bar() {
  local pct=$((CURRENT * 100 / TOTAL))
  local filled=$((pct / 4))
  local bar=""
  local i=0
  while [ $i -lt 25 ]; do
    if [ $i -lt $filled ]; then bar="${bar}█"; else bar="${bar}░"; fi
    i=$((i + 1))
  done
  printf "  ${B}[%s]${N} ${W}%3d%%${N}\n" "$bar" "$pct"
}

step() {
  # step "Label" command args...
  local label="$1"; shift
  CURRENT=$((CURRENT + 1))
  echo "==== [$CURRENT/$TOTAL] $label ====" >>"$LOG"
  "$@" >>"$LOG" 2>&1 &
  local pid=$!
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  while kill -0 $pid 2>/dev/null; do
    printf "\r  ${D}[%d/%d]${N} %-42s ${C}%s${N} " "$CURRENT" "$TOTAL" "$label" "${spin:$((i % 10)):1}"
    i=$((i + 1))
    sleep 0.15
  done
  wait $pid
  local rc=$?
  if [ $rc -eq 0 ]; then
    printf "\r  ${D}[%d/%d]${N} %-42s ${G}✓${N}  \n" "$CURRENT" "$TOTAL" "$label"
  else
    printf "\r  ${D}[%d/%d]${N} %-42s ${Y}⚠${N}  ${D}(non-fatal, see $LOG)${N}\n" "$CURRENT" "$TOTAL" "$label"
  fi
  return 0
}

fail() {
  echo ""
  echo "  ${R}✗ $1${N}"
  echo "  ${D}Install log: $LOG${N}"
  exit 1
}

# ── uninstall ──────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  echo "Removing File Expo…"
  systemctl stop "$SERVICE" 2>/dev/null
  systemctl disable "$SERVICE" 2>/dev/null
  rm -f "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload 2>/dev/null
  rm -rf "$APP_DIR" "$CONF_DIR"
  echo "Done. File Expo removed."
  exit 0
fi

# ── preflight ──────────────────────────────────────────────────
banner
[ "$(id -u)" -eq 0 ] || fail "Please run as root:  curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/install.sh | sudo bash"
: >"$LOG" 2>/dev/null || LOG="/tmp/file-expo-install.log"

# distro detection
DISTRO_ID="unknown"; DISTRO_NAME="Linux"; PM=""
if [ -r /etc/os-release ]; then
  . /etc/os-release
  DISTRO_ID="${ID:-unknown}"
  DISTRO_NAME="${PRETTY_NAME:-$DISTRO_ID}"
fi
case "$DISTRO_ID" in
  ubuntu|debian|linuxmint|pop|raspbian|kali) PM="apt" ;;
  arch|manjaro|endeavouros)                  PM="pacman" ;;
  fedora|centos|rhel|rocky|almalinux|amzn|ol) PM="dnf" ;;
  alpine)                                    PM="apk" ;;
  opensuse*|sles)                            PM="zypper" ;;
  *)
    for c in apt-get pacman dnf yum apk zypper; do
      command -v $c >/dev/null 2>&1 && { case $c in apt-get) PM=apt;; yum) PM=dnf;; *) PM=$c;; esac; break; }
    done ;;
esac

echo "  ${W}System :${N} $DISTRO_NAME"
echo "  ${W}Kernel :${N} $(uname -smr)"
echo "  ${W}Target :${N} $APP_DIR  (service: $SERVICE, port: $PORT)"
echo ""

# ── step 1: base packages ─────────────────────────────────────
install_base() {
  case "$PM" in
    apt)    DEBIAN_FRONTEND=noninteractive apt-get update -y
            DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates tar zip unzip file rsync ;;
    pacman) pacman -Sy --noconfirm --needed curl tar zip unzip file rsync ;;
    dnf)    dnf install -y curl tar zip unzip file rsync || yum install -y curl tar zip unzip file rsync ;;
    apk)    apk update && apk add curl tar zip unzip file rsync ;;
    zypper) zypper --non-interactive install curl tar zip unzip file rsync ;;
    *)      echo "unknown package manager — skipping base packages" ;;
  esac
}
step "Preparing system packages" install_base

# ── step 2: Node.js ────────────────────────────────────────────
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  v=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null) || return 1
  [ "${v:-0}" -ge 16 ]
}
install_node() {
  if node_ok; then echo "node $(node -v) already present"; return 0; fi
  case "$PM" in
    apt)    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
            DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs ;;
    pacman) pacman -S --noconfirm --needed nodejs npm ;;
    dnf)    dnf install -y nodejs || (curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && dnf install -y nodejs) ;;
    apk)    apk add nodejs npm ;;
    zypper) zypper --non-interactive install nodejs20 || zypper --non-interactive install nodejs ;;
    *)      return 1 ;;
  esac
  node_ok
}
step "Installing Node.js runtime" install_node
node_ok || fail "Node.js 16+ could not be installed. Install it manually, then re-run this script."

# ── step 3: download app ──────────────────────────────────────
download_app() {
  rm -rf /tmp/file-expo-dl
  mkdir -p /tmp/file-expo-dl
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o /tmp/file-expo-dl/app.tar.gz
  mkdir -p "$APP_DIR"
  # keep old copy until extraction succeeds
  rm -rf "$APP_DIR.new"
  mkdir -p "$APP_DIR.new"
  tar -xzf /tmp/file-expo-dl/app.tar.gz -C "$APP_DIR.new" --strip-components=1
  [ -f "$APP_DIR.new/server/server.js" ] || return 1
  rm -rf "$APP_DIR"
  mv "$APP_DIR.new" "$APP_DIR"
  rm -rf /tmp/file-expo-dl
}
step "Downloading File Expo" download_app
[ -f "$APP_DIR/server/server.js" ] || fail "Download failed — check your network and that github.com/$REPO exists."

# ── step 4: configuration ─────────────────────────────────────
TOKEN=""
configure() {
  mkdir -p "$CONF_DIR"
  if [ -f "$CONF_DIR/config.json" ] && grep -q '"configured": *true' "$CONF_DIR/config.json"; then
    echo "existing configuration kept"
    return 0
  fi
  TOKEN=$(tr -dc 'a-f0-9' </dev/urandom 2>/dev/null | head -c 32)
  [ -n "$TOKEN" ] || TOKEN=$(date +%s%N | sha256sum | head -c 32)
  cat >"$CONF_DIR/config.json" <<EOF
{
  "port": $PORT,
  "configured": false,
  "setupToken": "$TOKEN"
}
EOF
  chmod 600 "$CONF_DIR/config.json"
}
step "Writing configuration" configure
# re-read token (handles the "existing config" path)
TOKEN=$(grep -o '"setupToken": *"[a-f0-9]*"' "$CONF_DIR/config.json" 2>/dev/null | grep -o '[a-f0-9]\{32\}' || true)
CONFIGURED=$(grep -q '"configured": *true' "$CONF_DIR/config.json" 2>/dev/null && echo yes || echo no)

# ── step 5: service ───────────────────────────────────────────
HAS_SYSTEMD="no"
[ -d /run/systemd/system ] && HAS_SYSTEMD="yes"
install_service() {
  if [ "$HAS_SYSTEMD" = "yes" ]; then
    cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=File Expo web file manager
After=network.target

[Service]
ExecStart=$(command -v node) $APP_DIR/server/server.js
Restart=always
RestartSec=3
User=root
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE"
    systemctl restart "$SERVICE"
  else
    pkill -f "$APP_DIR/server/server.js" 2>/dev/null || true
    nohup node "$APP_DIR/server/server.js" >/var/log/file-expo.log 2>&1 &
    sleep 1
  fi
}
step "Installing system service" install_service

# ── step 6: verify it is running ──────────────────────────────
verify_running() {
  i=0
  while [ $i -lt 10 ]; do
    if curl -fsS "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}
step "Starting File Expo" verify_running
curl -fsS "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1 || fail "Service did not start. Check: journalctl -u $SERVICE -n 50"

# ── step 7: firewall ──────────────────────────────────────────
open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$PORT/tcp"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$PORT/tcp" && firewall-cmd --reload
  else
    echo "no active firewall manager detected"
  fi
}
step "Opening firewall port $PORT" open_firewall

# ── step 8: detect address ────────────────────────────────────
valid_ip() { echo "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; }
private_ip() { echo "$1" | grep -Eq '^(10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)'; }

get_public_ip() {
  local ip=""
  # ask the internet (forced IPv4 so we never get an IPv6 or a proxy answer)
  for svc in https://api.ipify.org https://checkip.amazonaws.com https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -4 -fsS -m 5 "$svc" 2>/dev/null | tr -d ' \r\n')
    valid_ip "$ip" && { echo "$ip"; return 0; }
  done
  # source address of the default outbound route (skips docker0 / br-* bridges)
  ip=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)
  valid_ip "$ip" && { echo "$ip"; return 0; }
  # first non-private address from hostname -I
  for cand in $(hostname -I 2>/dev/null); do
    valid_ip "$cand" && ! private_ip "$cand" && { echo "$cand"; return 0; }
  done
  # last resort: first address at all
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  valid_ip "$ip" && { echo "$ip"; return 0; }
  echo "YOUR-SERVER-IP"
}

IP=""
detect_ip() { IP=$(get_public_ip); echo "address: $IP"; }
step "Detecting server address" detect_ip
[ -n "$IP" ] || IP=$(get_public_ip)

progress_bar

# ── done ──────────────────────────────────────────────────────
echo ""
echo "  ${G}╔══════════════════════════════════════════════════════════════╗${N}"
echo "  ${G}║${N}   ${W}🗄️  File Expo is installed and running!${N}"
echo "  ${G}║${N}"
if [ "$CONFIGURED" = "yes" ]; then
echo "  ${G}║${N}   Open the file manager and sign in:"
echo "  ${G}║${N}"
echo "  ${G}║${N}   ${C}➜  http://$IP:$PORT${N}"
else
echo "  ${G}║${N}   ${W}Click this link to finish setup in your browser${N}"
echo "  ${G}║${N}   (you will create your admin password there):"
echo "  ${G}║${N}"
echo "  ${G}║${N}   ${C}➜  http://$IP:$PORT/?token=$TOKEN${N}"
fi
echo "  ${G}║${N}"
echo "  ${G}║${N}   ${D}Service : systemctl status $SERVICE${N}"
echo "  ${G}║${N}   ${D}Logs    : journalctl -u $SERVICE -f${N}"
echo "  ${G}║${N}   ${D}Update  : re-run this installer${N}"
echo "  ${G}╚══════════════════════════════════════════════════════════════╝${N}"
echo ""
