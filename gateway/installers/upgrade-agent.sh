#!/usr/bin/env bash
set -euo pipefail

SERVER_URL=
APP_DIR=/opt/remote-agent
DATA_DIR=/var/lib/remote-agent
SERVICE_NAME=remote-agent
CONFIG_FILE=
ACTION=upgrade
FORCE=0

usage() {
  cat <<'USAGE'
Upgrade a managed Remote Runtime device Agent without re-enrollment.

Usage:
  sudo remote-runtime-agent-upgrade [--check|--rollback|--force]

This script is normally fetched by the root-owned helper installed by
install-agent.sh. It authenticates to the Gateway with the existing device
credential, stages a new runtime, restarts the service, verifies that the new
build is online, and automatically rolls back on failure.
USAGE
}

while (($#)); do
  case "$1" in
    --server) SERVER_URL=${2:?missing URL}; shift 2 ;;
    --app-dir) APP_DIR=${2:?missing dir}; shift 2 ;;
    --data-dir) DATA_DIR=${2:?missing dir}; shift 2 ;;
    --service) SERVICE_NAME=${2:?missing name}; shift 2 ;;
    --config) CONFIG_FILE=${2:?missing path}; shift 2 ;;
    --check) ACTION=check; shift ;;
    --rollback) ACTION=rollback; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "remote-runtime-agent-upgrade must run as root" >&2
  exit 1
fi
[[ "$(uname -s)" == "Linux" ]] || { echo "Managed Agent upgrade currently supports Linux only." >&2; exit 1; }
[[ -n "$SERVER_URL" ]] || { echo "--server is required" >&2; exit 2; }
SERVER_URL=${SERVER_URL%/}
CONFIG_FILE=${CONFIG_FILE:-$DATA_DIR/config.json}
if [[ "$SERVER_URL" != https://* && "$SERVER_URL" != http://127.0.0.1:* && "$SERVER_URL" != http://localhost:* ]]; then
  echo "--server must use HTTPS unless it is localhost" >&2
  exit 2
fi
for command in curl systemctl flock readlink cp mv ln rm mktemp; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command not found: $command" >&2; exit 1; }
done
[[ -s "$CONFIG_FILE" ]] || { echo "Device credential not found: $CONFIG_FILE" >&2; exit 1; }
[[ -x "$APP_DIR/current/.venv/bin/python" ]] || { echo "Managed Agent runtime is missing under $APP_DIR/current" >&2; exit 1; }

PYTHON="$APP_DIR/current/.venv/bin/python"
mapfile -t DEVICE < <("$PYTHON" - "$CONFIG_FILE" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
for field in ("agent_id", "credential"):
    item = value.get(field)
    if not isinstance(item, str) or not item.strip() or "\n" in item:
        raise SystemExit(f"invalid device credential field: {field}")
    print(item.strip())
PY
)
[[ ${#DEVICE[@]} -eq 2 ]] || { echo "Device credential is invalid" >&2; exit 1; }
AGENT_ID=${DEVICE[0]}
CREDENTIAL=${DEVICE[1]}

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/remote-agent-upgrade.XXXXXX")
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM
CURL_CONFIG="$TMP_DIR/curl.conf"
printf 'header = "Authorization: Bearer %s"\n' "$CREDENTIAL" > "$CURL_CONFIG"
chmod 0600 "$CURL_CONFIG"
unset CREDENTIAL

self_status() {
  curl --fail --silent --show-error --config "$CURL_CONFIG" \
    "$SERVER_URL/api/agents/$AGENT_ID/self-status"
}

if [[ "$ACTION" == check ]]; then
  self_status | "$PYTHON" -m json.tool
  exit 0
fi

if [[ "$ACTION" == upgrade && "$FORCE" -eq 0 ]]; then
  STATUS_FILE="$TMP_DIR/preflight-status.json"
  self_status > "$STATUS_FILE"
  if "$PYTHON" - "$STATUS_FILE" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
raise SystemExit(0 if value.get("lifecycle_status") == "reenroll_required" else 1)
PY
  then
    echo "This Agent requires re-enrollment; in-place upgrade is not safe." >&2
    exit 2
  fi
  if "$PYTHON" - "$STATUS_FILE" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
raise SystemExit(0 if value.get("version_status") == "current" else 1)
PY
  then
    echo "Remote Runtime Agent is already current; use --force to reinstall the current release."
    exit 0
  fi
fi

LOCK_FILE="/var/lock/${SERVICE_NAME}.upgrade.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Another $SERVICE_NAME upgrade is already running" >&2; exit 1; }

CURRENT_LINK="$APP_DIR/current"
PREVIOUS_LINK="$APP_DIR/previous"
OLD_CURRENT=$(readlink -f "$CURRENT_LINK" || true)
[[ -n "$OLD_CURRENT" && -d "$OLD_CURRENT" ]] || { echo "Current managed release cannot be resolved" >&2; exit 1; }

wait_online() {
  local expected_build=${1:-}
  local deadline=$((SECONDS + 30))
  while ((SECONDS < deadline)); do
    local body="$TMP_DIR/status.json"
    if self_status > "$body" 2>/dev/null; then
      if "$PYTHON" - "$body" "$expected_build" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
expected = sys.argv[2]
version = value.get("version") or {}
ok = bool(value.get("online"))
if expected:
    ok = ok and version.get("build_id") == expected
raise SystemExit(0 if ok else 1)
PY
      then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

if [[ "$ACTION" == rollback ]]; then
  PREVIOUS=$(readlink -f "$PREVIOUS_LINK" || true)
  [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]] || { echo "No previous managed Agent release is available" >&2; exit 1; }
  systemctl stop "$SERVICE_NAME.service"
  if ! ln -sfn "$OLD_CURRENT" "$PREVIOUS_LINK" \
    || ! ln -sfn "$PREVIOUS" "$CURRENT_LINK" \
    || ! systemctl start "$SERVICE_NAME.service" \
    || ! wait_online ""; then
    systemctl stop "$SERVICE_NAME.service" || true
    ln -sfn "$OLD_CURRENT" "$CURRENT_LINK"
    systemctl start "$SERVICE_NAME.service" || true
    wait_online "" || true
    echo "Rollback target failed to reconnect; restored the original release" >&2
    exit 1
  fi
  echo "Remote Runtime Agent rolled back to: $PREVIOUS"
  exit 0
fi

BUNDLE_ZIP="$TMP_DIR/agent.zip"
echo "Downloading latest compatible Agent runtime…"
curl --fail --location --silent --show-error --retry 2 \
  --config "$CURL_CONFIG" \
  "$SERVER_URL/api/agents/$AGENT_ID/runtime-download" \
  --output "$BUNDLE_ZIP"

EXTRACT_DIR="$TMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"
"$PYTHON" - "$BUNDLE_ZIP" "$EXTRACT_DIR" <<'PY'
import pathlib, sys, zipfile
archive = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(archive) as handle:
    for item in handle.infolist():
        target = (root / item.filename).resolve()
        if target != root and root not in target.parents:
            raise SystemExit(f"unsafe archive path: {item.filename}")
    handle.extractall(root)
PY
SOURCE_DIR=$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit)
[[ -n "$SOURCE_DIR" && -f "$SOURCE_DIR/run.py" && -f "$SOURCE_DIR/requirements.txt" ]] || {
  echo "Downloaded Agent runtime has an invalid layout" >&2
  exit 1
}

mapfile -t RELEASE < <("$PYTHON" - "$SOURCE_DIR/remote_agent/manifest.json" <<'PY'
import json, pathlib, re, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
version = value.get("agent_version")
build = value.get("build_id")
if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise SystemExit("invalid agent version")
if not isinstance(build, str) or not re.fullmatch(r"[0-9A-Za-z._:-]{1,80}", build):
    raise SystemExit("invalid build id")
print(version)
print(build)
PY
)
[[ ${#RELEASE[@]} -eq 2 ]] || { echo "Downloaded Agent manifest is invalid" >&2; exit 1; }
VERSION=${RELEASE[0]}
BUILD_ID=${RELEASE[1]}
SAFE_BUILD=${BUILD_ID//:/_}
RELEASE_DIR="$APP_DIR/releases/v${VERSION}-${SAFE_BUILD}"
STAGING_DIR="$APP_DIR/releases/.staging-${SAFE_BUILD}-$$"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -a "$SOURCE_DIR"/. "$STAGING_DIR"/
"$PYTHON" -m venv "$STAGING_DIR/.venv"
"$STAGING_DIR/.venv/bin/python" -m pip install --disable-pip-version-check --quiet -r "$STAGING_DIR/requirements.txt"
"$STAGING_DIR/.venv/bin/python" "$STAGING_DIR/run.py" --help >/dev/null
chown -R root:root "$STAGING_DIR"
chmod -R u=rwX,g=rX,o=rX "$STAGING_DIR"
rm -rf "$RELEASE_DIR"
mv "$STAGING_DIR" "$RELEASE_DIR"

echo "Activating Agent $VERSION ($BUILD_ID)…"
systemctl stop "$SERVICE_NAME.service"
if ! ln -sfn "$OLD_CURRENT" "$PREVIOUS_LINK" \
  || ! ln -sfn "$RELEASE_DIR" "$CURRENT_LINK" \
  || ! systemctl start "$SERVICE_NAME.service" \
  || ! wait_online "$BUILD_ID"; then
  echo "New Agent did not reconnect in time; rolling back…" >&2
  systemctl stop "$SERVICE_NAME.service" || true
  ln -sfn "$OLD_CURRENT" "$CURRENT_LINK"
  systemctl start "$SERVICE_NAME.service" || true
  wait_online "" || true
  rm -rf "$RELEASE_DIR"
  echo "Upgrade failed and the previous release was restored" >&2
  exit 1
fi

echo "Remote Runtime Agent upgrade complete: $VERSION ($BUILD_ID)"
