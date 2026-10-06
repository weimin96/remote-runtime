#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/remote-agent-gateway
DATA_DIR=/var/lib/remote-agent-gateway
WORK_DIR=/srv/remote-agent-workspace
ALLOW_WORKDIRS=()
ENV_FILE=/etc/remote-agent-gateway.env
SERVICE_NAME=remote-agent-gateway
GATEWAY_USER=remote-agent-gateway
RUNNER_USER=remote-agent-runner
WORKSPACE_GROUP=remote-agent-workspace
CONTROL_GROUP=remote-agent-control
RUNTIME_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PUBLIC_URL=
OWNER_EMAIL=
PYTHON_BIN=
SOURCE_DIR=
SKIP_OWNER=0
NO_START=0
RELEASES_DIR=
CURRENT_LINK=
PREVIOUS_LINK=
RELEASE_ID=
RELEASE_DIR=

usage() {
  cat <<'USAGE'
Install Remote Runtime local execution mode on a systemd Linux host.

Usage:
  sudo ./deploy/install-local-runtime.sh --public-url https://gateway.example.com --owner-email you@example.com [options]

Options:
  --public-url URL        Public HTTPS origin used by OAuth (required)
  --owner-email EMAIL     Single owner email; interactive bootstrap is run if no owner exists
  --source-dir DIR        Source checkout to install (default: repository root containing this script)
  --workdir DIR           AI workspace root (default: /srv/remote-agent-workspace)
  --allow-workdir DIR     Add another allowed workspace root; may be repeated
  --data-dir DIR          Gateway private data directory (default: /var/lib/remote-agent-gateway)
  --app-dir DIR           Python runtime directory (default: /opt/remote-agent-gateway)
  --env-file PATH         Gateway env file (default: /etc/remote-agent-gateway.env)
  --service NAME          systemd service name (default: remote-agent-gateway)
  --python PATH           Python >=3.11. If omitted, discover system Python or use installed uv
  --gateway-user USER     Control-plane account (default: remote-agent-gateway)
  --runner-user USER      Shell execution account (default: remote-agent-runner)
  --workspace-group NAME  Shared workspace group (default: remote-agent-workspace)
  --control-group NAME    Private control config group (default: remote-agent-control)
  --skip-owner            Install without interactive owner bootstrap
  --no-start              Do not start systemd service after installation
  -h, --help              Show this help

The installer never grants root or Docker access to the runner. Add narrowly scoped
system privileges separately if a project needs them.
USAGE
}

while (($#)); do
  case "$1" in
    --public-url) PUBLIC_URL=${2:?missing URL}; shift 2 ;;
    --owner-email) OWNER_EMAIL=${2:?missing email}; shift 2 ;;
    --source-dir) SOURCE_DIR=${2:?missing dir}; shift 2 ;;
    --workdir) WORK_DIR=${2:?missing dir}; shift 2 ;;
    --allow-workdir) ALLOW_WORKDIRS+=("${2:?missing dir}"); shift 2 ;;
    --data-dir) DATA_DIR=${2:?missing dir}; shift 2 ;;
    --app-dir) APP_DIR=${2:?missing dir}; shift 2 ;;
    --env-file) ENV_FILE=${2:?missing path}; shift 2 ;;
    --service) SERVICE_NAME=${2:?missing name}; shift 2 ;;
    --python) PYTHON_BIN=${2:?missing path}; shift 2 ;;
    --gateway-user) GATEWAY_USER=${2:?missing user}; shift 2 ;;
    --runner-user) RUNNER_USER=${2:?missing user}; shift 2 ;;
    --workspace-group) WORKSPACE_GROUP=${2:?missing group}; shift 2 ;;
    --control-group) CONTROL_GROUP=${2:?missing group}; shift 2 ;;
    --skip-owner) SKIP_OWNER=1; shift ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "This installer must run as root." >&2
  exit 1
fi
if [[ -z "$PUBLIC_URL" ]]; then
  echo "--public-url is required" >&2
  exit 2
fi
if [[ "$PUBLIC_URL" != https://* && "$PUBLIC_URL" != http://127.0.0.1:* && "$PUBLIC_URL" != http://localhost:* ]]; then
  echo "--public-url must use HTTPS unless it is localhost" >&2
  exit 2
fi
if [[ "$SKIP_OWNER" -eq 0 && -z "$OWNER_EMAIL" ]]; then
  echo "--owner-email is required unless --skip-owner is used" >&2
  exit 2
fi

for value in "$APP_DIR" "$DATA_DIR" "$WORK_DIR" "$ENV_FILE" "$PUBLIC_URL" "$GATEWAY_USER" "$RUNNER_USER" "$WORKSPACE_GROUP" "$CONTROL_GROUP"; do
  if [[ "$value" =~ [[:space:]] ]]; then
    echo "Deployment paths/names/URL must not contain whitespace: $value" >&2
    exit 2
  fi
done
if [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "Invalid systemd service name: $SERVICE_NAME" >&2
  exit 2
fi
if ((${#ALLOW_WORKDIRS[@]})); then
  for value in "${ALLOW_WORKDIRS[@]}"; do
    if [[ "$value" =~ [[:space:]] ]]; then
      echo "Allowed workspace paths must not contain whitespace: $value" >&2
      exit 2
    fi
    [[ -d "$value" ]] || { echo "--allow-workdir does not exist or is not a directory: $value" >&2; exit 2; }
  done
fi

for command in systemctl useradd groupadd usermod sudo visudo getent install find curl readlink sed flock; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command not found: $command" >&2; exit 1; }
done

LOCK_FILE="/var/lock/${SERVICE_NAME}.deploy.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another install/upgrade is already running for $SERVICE_NAME" >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -z "$SOURCE_DIR" ]]; then
  SOURCE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
else
  SOURCE_DIR=$(cd "$SOURCE_DIR" && pwd)
fi
[[ -f "$SOURCE_DIR/pyproject.toml" ]] || { echo "No pyproject.toml under --source-dir: $SOURCE_DIR" >&2; exit 1; }

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
    local install_dir="$APP_DIR/.python"
    mkdir -p "$install_dir"
    uv python install 3.12 --install-dir "$install_dir"
    PYTHON_BIN=$(find "$install_dir" -type f -path '*/bin/python3.12' -perm -111 | head -n 1 || true)
    [[ -n "$PYTHON_BIN" ]] && python_ok "$PYTHON_BIN" && return
  fi
  echo "Python >=3.11 was not found. Install it or install uv and rerun." >&2
  exit 1
}

NOLOGIN=$(PATH="$RUNTIME_PATH" command -v nologin || true)
[[ -n "$NOLOGIN" ]] || NOLOGIN=/sbin/nologin
BASH_BIN=$(PATH="$RUNTIME_PATH" command -v bash || true)
SH_BIN=$(PATH="$RUNTIME_PATH" command -v sh || true)
ID_BIN=$(PATH="$RUNTIME_PATH" command -v id || true)
TMUX_BIN=$(PATH="$RUNTIME_PATH" command -v tmux || true)
[[ -n "$BASH_BIN" && -n "$SH_BIN" && -n "$ID_BIN" ]] || { echo "bash, sh and id are required" >&2; exit 1; }

getent group "$WORKSPACE_GROUP" >/dev/null 2>&1 || groupadd --system "$WORKSPACE_GROUP"
getent group "$CONTROL_GROUP" >/dev/null 2>&1 || groupadd --system "$CONTROL_GROUP"
getent passwd "$GATEWAY_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell "$NOLOGIN" "$GATEWAY_USER"
getent passwd "$RUNNER_USER" >/dev/null 2>&1 || useradd --system --home-dir "$WORK_DIR" --shell "$BASH_BIN" "$RUNNER_USER"
usermod -aG "$WORKSPACE_GROUP","$CONTROL_GROUP" "$GATEWAY_USER"
usermod -aG "$WORKSPACE_GROUP" "$RUNNER_USER"

install -d -m 0750 -o root -g "$CONTROL_GROUP" "$APP_DIR"
install -d -m 0700 -o "$GATEWAY_USER" -g "$CONTROL_GROUP" "$DATA_DIR"
install -d -m 2770 -o "$RUNNER_USER" -g "$WORKSPACE_GROUP" "$WORK_DIR"

find_python
RELEASES_DIR="$APP_DIR/releases"
CURRENT_LINK="$APP_DIR/current"
PREVIOUS_LINK="$APP_DIR/previous"
install -d -m 0755 -o root -g "$CONTROL_GROUP" "$RELEASES_DIR"
find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name '.staging-*' -exec rm -rf {} +

PROJECT_VERSION=$("$PYTHON_BIN" - "$SOURCE_DIR/pyproject.toml" <<'PY'
import pathlib, sys, tomllib
print(tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["project"]["version"])
PY
)
SOURCE_FINGERPRINT=$("$PYTHON_BIN" - "$SOURCE_DIR" <<'PY'
from __future__ import annotations
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
include_roots = [root / "gateway", root / "remote_agent"]
files = [root / "pyproject.toml", root / "agent.py"]
for include_root in include_roots:
    if include_root.is_dir():
        files.extend(
            path for path in include_root.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts
        )
digest = hashlib.sha256()
for path in sorted(set(files), key=lambda item: item.as_posix()):
    if not path.is_file():
        continue
    relative = path.relative_to(root).as_posix().encode()
    digest.update(len(relative).to_bytes(4, "big"))
    digest.update(relative)
    data = path.read_bytes()
    digest.update(len(data).to_bytes(8, "big"))
    digest.update(data)
print(digest.hexdigest()[:12])
PY
)
RELEASE_ID="v${PROJECT_VERSION}-${SOURCE_FINGERPRINT}"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"

OLD_CURRENT=
if [[ -L "$CURRENT_LINK" ]]; then
  OLD_CURRENT=$(readlink -f "$CURRENT_LINK" || true)
fi
LEGACY_EXEC=
if [[ -x "$APP_DIR/.venv/bin/python" ]]; then
  LEGACY_EXEC="$APP_DIR/.venv/bin/python -m gateway"
fi

if [[ ! -x "$RELEASE_DIR/.venv/bin/python" ]]; then
  STAGING_RELEASE="$RELEASES_DIR/.staging-${RELEASE_ID}-$$"
  rm -rf "$STAGING_RELEASE"
  install -d -m 0755 -o root -g "$CONTROL_GROUP" "$STAGING_RELEASE"
  if command -v uv >/dev/null 2>&1; then
    # `uv pip install --python` does not require pip to be pre-seeded in the venv.
    # Avoiding --seed removes a needless network/cache dependency during deployment.
    uv venv --python "$PYTHON_BIN" "$STAGING_RELEASE/.venv"
    uv pip install --python "$STAGING_RELEASE/.venv/bin/python" "$SOURCE_DIR"
  else
    "$PYTHON_BIN" -m venv "$STAGING_RELEASE/.venv"
    "$STAGING_RELEASE/.venv/bin/python" -m pip install --upgrade pip
    "$STAGING_RELEASE/.venv/bin/python" -m pip install "$SOURCE_DIR"
  fi
  "$STAGING_RELEASE/.venv/bin/python" -c 'import gateway, remote_agent; print(gateway.__version__)' >/dev/null
  chown -R root:"$CONTROL_GROUP" "$STAGING_RELEASE"
  # Runtime code is readable/executable by the runner; secrets live outside release dirs.
  chmod -R u=rwX,g=rX,o=rX "$STAGING_RELEASE"
  if [[ -e "$RELEASE_DIR" ]]; then
    rm -rf "$RELEASE_DIR"
  fi
  mv "$STAGING_RELEASE" "$RELEASE_DIR"
fi

if [[ ! -f "$RELEASE_DIR/release.json" ]]; then
  "$PYTHON_BIN" - "$RELEASE_DIR/release.json" "$PROJECT_VERSION" "$RELEASE_ID" "$SOURCE_FINGERPRINT" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
manifest = {
    "format_version": 1,
    "project": "remote-agent-gateway",
    "artifact_type": "source-runtime",
    "version": sys.argv[2],
    "release_id": sys.argv[3],
    "source_fingerprint": sys.argv[4],
}
path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
path.chmod(0o644)
PY
  chown root:"$CONTROL_GROUP" "$RELEASE_DIR/release.json"
fi

if [[ -n "$OLD_CURRENT" && "$OLD_CURRENT" != "$RELEASE_DIR" ]]; then
  ln -sfn "$OLD_CURRENT" "$PREVIOUS_LINK"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
chmod 0755 "$APP_DIR"
if [[ -d "$APP_DIR/.python" ]]; then
  chown -R root:"$CONTROL_GROUP" "$APP_DIR/.python"
  chmod -R u=rwX,g=rX,o=rX "$APP_DIR/.python"
fi

PROJECT_HELPER=/usr/local/bin/remote-project
UPGRADE_HELPER=/usr/local/sbin/remote-agent-upgrade
DOCTOR_HELPER=/usr/local/sbin/remote-agent-doctor
cat > "$PROJECT_HELPER" <<HELPER
#!/bin/sh
exec "$CURRENT_LINK/.venv/bin/python" -m gateway.project_cli "\$@"
HELPER
chown root:root "$PROJECT_HELPER"
chmod 0755 "$PROJECT_HELPER"
install -m 0755 "$SOURCE_DIR/deploy/upgrade-local-runtime.sh" "$UPGRADE_HELPER"
install -m 0755 "$SOURCE_DIR/deploy/check-local-runtime.sh" "$DOCTOR_HELPER"

SECURE_COOKIES=true
if [[ "$PUBLIC_URL" == http://127.0.0.1:* || "$PUBLIC_URL" == http://localhost:* ]]; then
  SECURE_COOKIES=false
fi

EXTRA_WORKDIRS=
if ((${#ALLOW_WORKDIRS[@]})); then
  EXTRA_WORKDIRS=$(IFS=:; echo "${ALLOW_WORKDIRS[*]}")
fi

cat > "$ENV_FILE" <<ENV
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=8000
GATEWAY_PUBLIC_URL=$PUBLIC_URL
GATEWAY_SECURE_COOKIES=$SECURE_COOKIES
GATEWAY_DATA_DIR=$DATA_DIR
GATEWAY_LOCAL_WORKDIR=$WORK_DIR
GATEWAY_LOCAL_WORKDIRS=$EXTRA_WORKDIRS
GATEWAY_LOCAL_EXEC_USER=$RUNNER_USER
ENV
chown root:"$CONTROL_GROUP" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

SUDOERS_FILE="/etc/sudoers.d/$SERVICE_NAME"
SUDO_COMMANDS="$BASH_BIN, $SH_BIN, $ID_BIN"
if [[ -n "$TMUX_BIN" ]]; then
  SUDO_COMMANDS="$SUDO_COMMANDS, $TMUX_BIN"
fi
cat > "$SUDOERS_FILE" <<SUDOERS
Defaults:$GATEWAY_USER !requiretty
$GATEWAY_USER ALL=($RUNNER_USER) NOPASSWD: $SUDO_COMMANDS
SUDOERS
chmod 0440 "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE" >/dev/null

SERVICE_FILE=/etc/systemd/system/$SERVICE_NAME.service
cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=Remote Runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$GATEWAY_USER
Group=$WORKSPACE_GROUP
SupplementaryGroups=$CONTROL_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=PATH=$RUNTIME_PATH
ExecStart=$CURRENT_LINK/.venv/bin/python -m gateway
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
UMask=0077
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null

owner_exists() {
  sudo -u "$GATEWAY_USER" "$BASH_BIN" -c 'set -a; . "$1"; set +a; exec "$2" -c '\''from gateway.config import Settings; from gateway.database import Database; s=Settings.from_env(); d=Database(s.database_path); d.initialize(); raise SystemExit(0 if d.get_owner() else 1)'\''' _ "$ENV_FILE" "$CURRENT_LINK/.venv/bin/python"
}

health_wait() {
  local attempt
  for attempt in $(seq 1 30); do
    if systemctl is-active --quiet "$SERVICE_NAME" && curl -fsS "http://127.0.0.1:8000/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

HAS_OWNER=0
if owner_exists; then
  HAS_OWNER=1
elif [[ "$SKIP_OWNER" -eq 0 ]]; then
  echo
  echo "Bootstrapping the single owner. Enter a strong password; TOTP and recovery codes will be shown once."
  sudo -u "$GATEWAY_USER" "$BASH_BIN" -c 'set -a; . "$1"; set +a; exec "$2" -m gateway.bootstrap_owner "$3"' _ "$ENV_FILE" "$CURRENT_LINK/.venv/bin/python" "$OWNER_EMAIL"
  HAS_OWNER=1
else
  echo "Owner bootstrap skipped; service will remain stopped until an Owner with MFA exists." >&2
  NO_START=1
fi

# Deployment-time invariants: runner must not read control config or database.
if sudo -u "$RUNNER_USER" test -r "$ENV_FILE"; then
  echo "Security check failed: runner can read $ENV_FILE" >&2
  exit 1
fi
if [[ -e "$DATA_DIR/gateway.db" ]] && sudo -u "$RUNNER_USER" test -r "$DATA_DIR/gateway.db"; then
  echo "Security check failed: runner can read Gateway database" >&2
  exit 1
fi
sudo -u "$GATEWAY_USER" sudo -n -u "$RUNNER_USER" -- "$ID_BIN" -u >/dev/null
sudo -u "$RUNNER_USER" "$PROJECT_HELPER" inspect "$WORK_DIR" >/dev/null
if ((${#ALLOW_WORKDIRS[@]})); then
  for root in "${ALLOW_WORKDIRS[@]}"; do
    sudo -u "$GATEWAY_USER" test -x "$root" || { echo "Gateway cannot traverse allowed workspace: $root" >&2; exit 1; }
    sudo -u "$RUNNER_USER" test -x "$root" || { echo "Runner cannot traverse allowed workspace: $root" >&2; exit 1; }
  done
fi

if [[ "$NO_START" -eq 0 ]]; then
  if ! systemctl restart "$SERVICE_NAME" || ! health_wait; then
    echo "New release failed health checks; attempting automatic rollback." >&2
    if [[ -n "$OLD_CURRENT" && -x "$OLD_CURRENT/.venv/bin/python" ]]; then
      ln -sfn "$OLD_CURRENT" "$CURRENT_LINK"
      systemctl restart "$SERVICE_NAME" || true
    elif [[ -n "$LEGACY_EXEC" ]]; then
      sed -i "s#^ExecStart=.*#ExecStart=$LEGACY_EXEC#" "$SERVICE_FILE"
      systemctl daemon-reload
      systemctl restart "$SERVICE_NAME" || true
    fi
    exit 1
  fi
fi

echo
echo "Remote Runtime installed successfully."
echo "  Public URL : $PUBLIC_URL"
echo "  Workspace  : $WORK_DIR"
if ((${#ALLOW_WORKDIRS[@]})); then
  printf '  Extra roots:'
  printf ' %s' "${ALLOW_WORKDIRS[@]}"
  printf '\n'
fi
echo "  Data       : $DATA_DIR"
echo "  Release    : $RELEASE_ID"
echo "  Current    : $CURRENT_LINK"
echo "  Control    : $GATEWAY_USER"
echo "  Runner     : $RUNNER_USER"
echo "  Upgrade    : $UPGRADE_HELPER"
echo "  Doctor     : $DOCTOR_HELPER"
if [[ -n "$TMUX_BIN" ]]; then
  echo "  Persistent : enabled via $TMUX_BIN"
else
  echo "  Persistent : unavailable (install tmux to enable persistent=true)"
fi
echo "Expose only OAuth discovery, /oauth/* and /mcp/* through your HTTPS reverse proxy."
