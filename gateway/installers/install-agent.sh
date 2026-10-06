#!/usr/bin/env bash
set -euo pipefail

SERVER_URL=
GATEWAY_URL=
BUNDLE_ID=
TOKEN=${REMOTE_RUNTIME_TOKEN:-}
INPUT_TOKEN_FILE=
WORK_DIR=/srv/remote-agent-work
APP_DIR=/opt/remote-agent
DATA_DIR=/var/lib/remote-agent
SERVICE_NAME=remote-agent
AGENT_USER=remote-agent
PYTHON_BIN=
NO_START=0
RUNTIME_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

usage() {
  cat <<'USAGE'
Install a Remote Runtime device Agent on a systemd Linux host.

Usage:
  curl -fsSL https://runtime.example.com/install-agent.sh | sudo bash -s -- \
    --server https://runtime.example.com \
    --gateway wss://runtime.example.com/ws/agent \
    --bundle-id <bundle-id>

The installer asks for the one-time Enrollment Token on /dev/tty so the secret is
not stored in shell history. For unattended automation, set REMOTE_RUNTIME_TOKEN
in the installer process environment or pass --token explicitly.

Options:
  --server URL       Gateway HTTPS origin used to download the Agent bundle
  --gateway URL      Agent WebSocket URL (ws:// or wss://)
  --bundle-id ID     Agent bundle ID created by the Gateway
  --token TOKEN      One-time Enrollment Token (prefer the interactive prompt)
  --token-file FILE  Read Token from FILE and delete it immediately after reading
  --workdir DIR      Agent workspace (default: /srv/remote-agent-work)
  --app-dir DIR      Read-only runtime root (default: /opt/remote-agent)
  --data-dir DIR     Private Agent state (default: /var/lib/remote-agent)
  --service NAME     systemd service name (default: remote-agent)
  --user USER        Dedicated system user (default: remote-agent)
  --python PATH      Python >=3.11; auto-discovered when omitted
  --no-start         Enroll and install, but do not enable/start the service
  -h, --help         Show this help
USAGE
}

while (($#)); do
  case "$1" in
    --server) SERVER_URL=${2:?missing URL}; shift 2 ;;
    --gateway) GATEWAY_URL=${2:?missing URL}; shift 2 ;;
    --bundle-id) BUNDLE_ID=${2:?missing bundle id}; shift 2 ;;
    --token) TOKEN=${2:?missing token}; shift 2 ;;
    --token-file) INPUT_TOKEN_FILE=${2:?missing token file}; shift 2 ;;
    --workdir) WORK_DIR=${2:?missing dir}; shift 2 ;;
    --app-dir) APP_DIR=${2:?missing dir}; shift 2 ;;
    --data-dir) DATA_DIR=${2:?missing dir}; shift 2 ;;
    --service) SERVICE_NAME=${2:?missing name}; shift 2 ;;
    --user) AGENT_USER=${2:?missing user}; shift 2 ;;
    --python) PYTHON_BIN=${2:?missing path}; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
unset REMOTE_RUNTIME_TOKEN || true

if [[ -n "$TOKEN" && -n "$INPUT_TOKEN_FILE" ]]; then
  echo "Use only one of REMOTE_RUNTIME_TOKEN/--token or --token-file" >&2
  exit 2
fi

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "This installer must run as root (pipe it to sudo bash)." >&2
  exit 1
fi
[[ "$(uname -s)" == "Linux" ]] || { echo "This installer currently supports Linux only." >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemd/systemctl is required." >&2; exit 1; }

[[ -n "$SERVER_URL" ]] || { echo "--server is required" >&2; exit 2; }
[[ -n "$GATEWAY_URL" ]] || { echo "--gateway is required" >&2; exit 2; }
[[ -n "$BUNDLE_ID" ]] || { echo "--bundle-id is required" >&2; exit 2; }
SERVER_URL=${SERVER_URL%/}
[[ "$BUNDLE_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { echo "--bundle-id format is invalid" >&2; exit 2; }
[[ ! "$SERVER_URL" =~ [[:space:]] && ! "$GATEWAY_URL" =~ [[:space:]] ]] || {
  echo "Gateway URLs must not contain whitespace" >&2
  exit 2
}
if [[ "$SERVER_URL" != https://* && "$SERVER_URL" != http://127.0.0.1:* && "$SERVER_URL" != http://localhost:* ]]; then
  echo "--server must use HTTPS unless it is localhost" >&2
  exit 2
fi
if [[ "$GATEWAY_URL" != wss://* && "$GATEWAY_URL" != ws://127.0.0.1:* && "$GATEWAY_URL" != ws://localhost:* ]]; then
  echo "--gateway must use WSS unless it is localhost" >&2
  exit 2
fi
if [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ || ! "$AGENT_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "Invalid service or user name" >&2
  exit 2
fi
for value in "$APP_DIR" "$DATA_DIR" "$WORK_DIR"; do
  [[ "$value" == /* ]] || { echo "Installation paths must be absolute: $value" >&2; exit 2; }
  [[ ! "$value" =~ [[:space:]] ]] || { echo "Installation paths must not contain whitespace: $value" >&2; exit 2; }
done

if [[ -n "$INPUT_TOKEN_FILE" ]]; then
  [[ -f "$INPUT_TOKEN_FILE" && -r "$INPUT_TOKEN_FILE" ]] || { echo "Enrollment Token file is not readable: $INPUT_TOKEN_FILE" >&2; exit 2; }
  TOKEN=$(cat -- "$INPUT_TOKEN_FILE")
  rm -f -- "$INPUT_TOKEN_FILE"
  INPUT_TOKEN_FILE=
fi
if [[ -z "$TOKEN" ]]; then
  if [[ -r /dev/tty ]]; then
    printf 'Enrollment Token: ' >/dev/tty
    IFS= read -r -s TOKEN </dev/tty
    printf '\n' >/dev/tty
  else
    echo "Enrollment Token is required. Set REMOTE_RUNTIME_TOKEN for unattended installation." >&2
    exit 2
  fi
fi
[[ "$TOKEN" == enroll_* ]] || { echo "Enrollment Token format is invalid" >&2; exit 2; }

for command in curl unzip useradd getent install runuser flock id stat grep find mktemp cp mv ln rm chown chmod cat; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command not found: $command" >&2; exit 1; }
done

LOCK_FILE="/var/lock/${SERVICE_NAME}.install.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Another $SERVICE_NAME install is already running" >&2; exit 1; }

CONFIG_FILE="$DATA_DIR/config.json"
TOKEN_FILE="$DATA_DIR/.enrollment-token"
if [[ -e "$CONFIG_FILE" ]]; then
  echo "This machine is already enrolled: $CONFIG_FILE" >&2
  echo "Refusing to consume a new Enrollment Token. Revoke/reinstall explicitly instead." >&2
  exit 2
fi

python_ok() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

find_python() {
  if [[ -n "$PYTHON_BIN" ]]; then
    python_ok "$PYTHON_BIN" || { echo "--python must point to Python >=3.11" >&2; exit 1; }
    return
  fi
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && python_ok "$(command -v "$candidate")"; then
      PYTHON_BIN=$(command -v "$candidate")
      return
    fi
  done
  if command -v uv >/dev/null 2>&1; then
    install -d -m 0755 "$APP_DIR/.python"
    uv python install 3.12 --install-dir "$APP_DIR/.python"
    PYTHON_BIN=$(find "$APP_DIR/.python" -type f -path '*/bin/python3.12' -perm -111 | head -n 1 || true)
    [[ -n "$PYTHON_BIN" ]] && python_ok "$PYTHON_BIN" && return
  fi
  echo "Python >=3.11 was not found. Install Python 3.11+ (or uv) and rerun." >&2
  exit 1
}

NOLOGIN=$(PATH="$RUNTIME_PATH" command -v nologin || true)
[[ -n "$NOLOGIN" ]] || NOLOGIN=/sbin/nologin
getent passwd "$AGENT_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell "$NOLOGIN" "$AGENT_USER"
AGENT_GROUP=$(id -gn "$AGENT_USER")
install -d -m 0755 -o root -g root "$APP_DIR" "$APP_DIR/releases"
install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_GROUP" "$DATA_DIR"
if [[ -e "$WORK_DIR" ]]; then
  [[ -d "$WORK_DIR" ]] || { echo "--workdir exists but is not a directory: $WORK_DIR" >&2; exit 2; }
  if ! runuser -u "$AGENT_USER" -- test -r "$WORK_DIR" || ! runuser -u "$AGENT_USER" -- test -w "$WORK_DIR"; then
    echo "Existing --workdir is not readable/writable by $AGENT_USER: $WORK_DIR" >&2
    echo "Grant the dedicated Agent account access explicitly; the installer will not change ownership of an existing project directory." >&2
    exit 2
  fi
else
  install -d -m 0750 -o "$AGENT_USER" -g "$AGENT_GROUP" "$WORK_DIR"
fi
find_python

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/remote-agent-install.XXXXXX")
cleanup() {
  rm -rf "$TMP_DIR"
  rm -f "$TOKEN_FILE"
}
trap cleanup EXIT INT TERM

CURL_CONFIG="$TMP_DIR/curl.conf"
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$CURL_CONFIG"
chmod 0600 "$CURL_CONFIG"
BUNDLE_ZIP="$TMP_DIR/agent.zip"
echo "Downloading Remote Runtime Agent bundle…"
curl --fail --location --silent --show-error --retry 2 \
  --config "$CURL_CONFIG" \
  "$SERVER_URL/api/agent-bundles/$BUNDLE_ID/install-download" \
  --output "$BUNDLE_ZIP"
rm -f "$CURL_CONFIG"

EXTRACT_DIR="$TMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"
unzip -q "$BUNDLE_ZIP" -d "$EXTRACT_DIR"
SOURCE_DIR=$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit)
[[ -n "$SOURCE_DIR" && -f "$SOURCE_DIR/run.py" && -f "$SOURCE_DIR/requirements.txt" ]] || {
  echo "Downloaded Agent bundle has an invalid layout" >&2
  exit 1
}

RELEASE_DIR="$APP_DIR/releases/$BUNDLE_ID"
STAGING_DIR="$APP_DIR/releases/.staging-$BUNDLE_ID-$$"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -a "$SOURCE_DIR"/. "$STAGING_DIR"/
"$PYTHON_BIN" -m venv "$STAGING_DIR/.venv"
"$STAGING_DIR/.venv/bin/python" -m pip install --disable-pip-version-check --quiet -r "$STAGING_DIR/requirements.txt"
"$STAGING_DIR/.venv/bin/python" "$STAGING_DIR/run.py" --help >/dev/null
chown -R root:root "$STAGING_DIR"
chmod -R u=rwX,g=rX,o=rX "$STAGING_DIR"
rm -rf "$RELEASE_DIR"
mv "$STAGING_DIR" "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$APP_DIR/current"

printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
chown "$AGENT_USER:$AGENT_GROUP" "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"
unset TOKEN

echo "Enrolling device…"
runuser -u "$AGENT_USER" -- \
  "$APP_DIR/current/.venv/bin/python" "$APP_DIR/current/run.py" \
  --gateway "$GATEWAY_URL" \
  --token-file "$TOKEN_FILE" \
  --config "$CONFIG_FILE" \
  --workdir "$WORK_DIR" \
  --enroll-only

[[ -s "$CONFIG_FILE" ]] || { echo "Enrollment did not create device credentials" >&2; exit 1; }
chown "$AGENT_USER:$AGENT_GROUP" "$CONFIG_FILE"
chmod 0600 "$CONFIG_FILE"

SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=Remote Runtime device agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$AGENT_USER
Group=$AGENT_GROUP
WorkingDirectory=$WORK_DIR
ExecStart=$APP_DIR/current/.venv/bin/python $APP_DIR/current/run.py --config $CONFIG_FILE --workdir $WORK_DIR
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$DATA_DIR $WORK_DIR

[Install]
WantedBy=multi-user.target
SERVICE
chmod 0644 "$SERVICE_FILE"

DOCTOR_FILE=/usr/local/sbin/remote-runtime-agent-doctor
cat > "$DOCTOR_FILE" <<DOCTOR
#!/bin/sh
set -eu

failures=0
ok() { printf '[OK] %s\n' "\$1"; }
fail() { printf '[FAIL] %s\n' "\$1" >&2; failures=\$((failures + 1)); }

if [ "\$(id -u)" -ne 0 ]; then
  echo "remote-agent-doctor must run as root" >&2
  exit 2
fi

[ -L "$APP_DIR/current" ] && [ -f "$APP_DIR/current/run.py" ] \
  && ok "managed Agent runtime" || fail "managed Agent runtime"
[ -x "$APP_DIR/current/.venv/bin/python" ] \
  && "$APP_DIR/current/.venv/bin/python" "$APP_DIR/current/run.py" --help >/dev/null 2>&1 \
  && ok "Agent Python runtime" || fail "Agent Python runtime"
[ -x "/usr/local/sbin/remote-runtime-agent-upgrade" ] \
  && ok "managed upgrade helper" || fail "managed upgrade helper"
[ -s "$CONFIG_FILE" ] && ok "device credential exists" || fail "device credential exists"
if [ -e "$CONFIG_FILE" ]; then
  [ "\$(stat -c '%a' "$CONFIG_FILE")" = "600" ] \
    && ok "device credential mode 0600" || fail "device credential mode 0600"
  [ "\$(stat -c '%U' "$CONFIG_FILE")" = "$AGENT_USER" ] \
    && ok "device credential owner" || fail "device credential owner"
fi
[ -d "$WORK_DIR" ] && runuser -u "$AGENT_USER" -- test -w "$WORK_DIR" \
  && ok "workspace writable by $AGENT_USER" || fail "workspace writable by $AGENT_USER"
if grep -Eq -- '--token|REMOTE_RUNTIME_TOKEN|enroll_' "$SERVICE_FILE"; then
  fail "systemd unit contains enrollment secret material"
else
  ok "systemd unit contains no enrollment token"
fi
systemctl is-enabled --quiet "$SERVICE_NAME.service" \
  && ok "service enabled" || fail "service enabled"
systemctl is-active --quiet "$SERVICE_NAME.service" \
  && ok "service active" || fail "service active"

if [ "\$failures" -ne 0 ]; then
  echo "Remote Runtime Agent doctor failed: \$failures check(s)" >&2
  exit 1
fi
echo "Remote Runtime Agent doctor: all checks passed"
DOCTOR
chmod 0755 "$DOCTOR_FILE"

UPGRADE_FILE=/usr/local/sbin/remote-runtime-agent-upgrade
cat > "$UPGRADE_FILE" <<UPGRADE
#!/bin/sh
set -eu
SCRIPT=\$(mktemp "\${TMPDIR:-/tmp}/remote-agent-upgrade-script.XXXXXX")
cleanup() { rm -f "\$SCRIPT"; }
trap cleanup EXIT INT TERM
curl --fail --silent --show-error --location \
  "$SERVER_URL/upgrade-agent.sh" --output "\$SCRIPT"
chmod 0700 "\$SCRIPT"
/bin/bash "\$SCRIPT" \
  --server "$SERVER_URL" \
  --app-dir "$APP_DIR" \
  --data-dir "$DATA_DIR" \
  --config "$CONFIG_FILE" \
  --service "$SERVICE_NAME" \
  "\$@"
UPGRADE
chmod 0755 "$UPGRADE_FILE"
systemctl daemon-reload

if [[ "$NO_START" -eq 0 ]]; then
  systemctl enable --now "$SERVICE_NAME.service"
  sleep 1
  if ! systemctl is-active --quiet "$SERVICE_NAME.service"; then
    echo "Agent service failed to start. Recent logs:" >&2
    journalctl -u "$SERVICE_NAME.service" -n 40 --no-pager >&2 || true
    exit 1
  fi
  "$DOCTOR_FILE"
fi

echo
echo "Remote Runtime Agent installed successfully."
echo "  Service:   $SERVICE_NAME.service"
echo "  Runtime:   $APP_DIR/current"
echo "  State:     $DATA_DIR"
echo "  Workspace: $WORK_DIR"
echo "  Doctor:    $DOCTOR_FILE"
echo "  Upgrade:   $UPGRADE_FILE"
if [[ "$NO_START" -eq 0 ]]; then
  echo "  Status:    active"
else
  echo "  Status:    installed (not started)"
fi
