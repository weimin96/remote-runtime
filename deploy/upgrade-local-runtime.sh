#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/remote-agent-gateway
ENV_FILE=/etc/remote-agent-gateway.env
SERVICE_NAME=remote-agent-gateway
ALLOW_DIRTY=0
GITHUB_REPOSITORY=${REMOTE_RUNTIME_GITHUB_REPOSITORY:-weimin96/remote-runtime}
GITHUB_TOKEN_FILE=${REMOTE_RUNTIME_GITHUB_TOKEN_FILE:-/etc/remote-runtime/github-token}
COMMAND=
ARG=
RELEASE_TAG=

usage() {
  cat <<'USAGE'
Upgrade or roll back a managed local Remote Runtime deployment.

Usage:
  sudo ./deploy/upgrade-local-runtime.sh --version VERSION [options]
  sudo ./deploy/upgrade-local-runtime.sh --ref RELEASE_TAG [options]
  sudo ./deploy/upgrade-local-runtime.sh install RELEASE.tar.gz [options]
  sudo ./deploy/upgrade-local-runtime.sh rollback [options]
  sudo ./deploy/upgrade-local-runtime.sh list [options]

Options:
  --app-dir DIR       Managed application root (default: /opt/remote-agent-gateway)
  --env-file PATH     Gateway env file (default: /etc/remote-agent-gateway.env)
  --service NAME      systemd service (default: remote-agent-gateway)
  --github-repo REPO  GitHub repository (default: weimin96/remote-runtime)
  --github-token-file PATH
                       Root-owned fine-grained PAT file for private GitHub releases
  --allow-dirty       Allow a development artifact whose manifest is marked dirty
  -h, --help          Show this help

The script never overwrites Gateway data, OAuth/MFA state, or the env file. A failed
new release is switched back automatically. Manual rollback changes application code
only and intentionally does not restore an older database snapshot.
USAGE
}

[[ $# -gt 0 ]] || { usage >&2; exit 2; }
case "$1" in
  --version)
    COMMAND=github-install
    [[ $# -ge 2 ]] || { echo "--version requires a version" >&2; exit 2; }
    RELEASE_TAG="v${2#v}"
    shift 2
    ;;
  --ref)
    COMMAND=github-install
    [[ $# -ge 2 ]] || { echo "--ref requires a release tag" >&2; exit 2; }
    RELEASE_TAG=$2
    shift 2
    ;;
  install)
    COMMAND=install
    shift
    [[ $# -gt 0 ]] || { echo "install requires a release tar.gz" >&2; exit 2; }
    ARG=$1
    shift
    ;;
  rollback) COMMAND=rollback; shift ;;
  list) COMMAND=list; shift ;;
  -h|--help) usage; exit 0 ;;
  *) echo "Unknown command: $1" >&2; usage >&2; exit 2 ;;
esac

while (($#)); do
  case "$1" in
    --app-dir) APP_DIR=${2:?missing dir}; shift 2 ;;
    --env-file) ENV_FILE=${2:?missing path}; shift 2 ;;
    --service) SERVICE_NAME=${2:?missing service}; shift 2 ;;
    --github-repo) GITHUB_REPOSITORY=${2:?missing repository}; shift 2 ;;
    --github-token-file) GITHUB_TOKEN_FILE=${2:?missing path}; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "This command must run as root." >&2
  exit 1
fi
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid GitHub repository: $GITHUB_REPOSITORY" >&2; exit 2; }
if [[ -n "$RELEASE_TAG" ]]; then
  [[ "$RELEASE_TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$ ]] || { echo "Invalid release tag: $RELEASE_TAG" >&2; exit 2; }
fi
for command in systemctl sudo curl id find readlink sed install flock stat; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command not found: $command" >&2; exit 1; }
done

LOCK_FILE="/var/lock/${SERVICE_NAME}.deploy.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another install/upgrade is already running for $SERVICE_NAME" >&2
  exit 1
fi

RELEASES_DIR="$APP_DIR/releases"
CURRENT_LINK="$APP_DIR/current"
PREVIOUS_LINK="$APP_DIR/previous"
[[ -d "$RELEASES_DIR" ]] || { echo "Managed release layout not found under $APP_DIR. Run install-local-runtime.sh once first." >&2; exit 1; }
[[ -r "$ENV_FILE" ]] || { echo "Env file is not readable: $ENV_FILE" >&2; exit 1; }
find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name '.staging-*' -exec rm -rf {} +

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${GATEWAY_PORT:?missing GATEWAY_PORT in env file}"
: "${GATEWAY_DATA_DIR:?missing GATEWAY_DATA_DIR in env file}"
GATEWAY_DATABASE=${GATEWAY_DATABASE:-$GATEWAY_DATA_DIR/gateway.db}

GATEWAY_USER=$(systemctl show "$SERVICE_NAME" -p User 2>/dev/null | sed -n 's/^User=//p')
[[ -n "$GATEWAY_USER" ]] || { echo "Could not resolve systemd User for $SERVICE_NAME" >&2; exit 1; }
GATEWAY_GROUP=$(id -gn "$GATEWAY_USER")

CURRENT_PYTHON=
if [[ -x "$CURRENT_LINK/.venv/bin/python" ]]; then
  CURRENT_PYTHON="$CURRENT_LINK/.venv/bin/python"
fi
[[ -n "$CURRENT_PYTHON" ]] || { echo "Current managed Python was not found" >&2; exit 1; }

read_json_field() {
  "$CURRENT_PYTHON" - "$1" "$2" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
PY
}

github_curl_config() {
  local destination=$1 token= owner mode
  [[ -e "$GITHUB_TOKEN_FILE" ]] || return 1
  [[ -f "$GITHUB_TOKEN_FILE" && ! -L "$GITHUB_TOKEN_FILE" ]] || {
    echo "GitHub token path must be a regular non-symlink file: $GITHUB_TOKEN_FILE" >&2
    return 2
  }
  owner=$(stat -c '%u' "$GITHUB_TOKEN_FILE")
  mode=$(stat -c '%a' "$GITHUB_TOKEN_FILE")
  [[ "$owner" == 0 ]] || {
    echo "GitHub token file must be owned by root: $GITHUB_TOKEN_FILE" >&2
    return 2
  }
  if (( (8#$mode & 077) != 0 )); then
    echo "GitHub token file must not be readable or writable by group/others: $GITHUB_TOKEN_FILE" >&2
    return 2
  fi
  IFS= read -r token <"$GITHUB_TOKEN_FILE" || true
  token=${token%$'\r'}
  [[ -n "$token" && "$token" != *[[:space:]]* ]] || {
    echo "GitHub token file must contain one non-empty token line." >&2
    return 2
  }
  umask 077
  printf 'header = "Authorization: Bearer %s"\nheader = "X-GitHub-Api-Version: 2022-11-28"\n' "$token" >"$destination"
  token=
  return 0
}

download_github_release() {
  local tag=$1 destination=$2 release_json="$destination/release.json" auth_config="$destination/github-curl.conf"
  local api_path="repos/$GITHUB_REPOSITORY/releases/tags/$tag"
  local curl_args=(--fail --location --silent --show-error --retry 3 --retry-delay 1)
  local auth_status=0
  github_curl_config "$auth_config" || auth_status=$?
  if [[ "$auth_status" -eq 0 ]]; then
    curl_args+=(--config "$auth_config")
  elif [[ "$auth_status" -ne 1 ]]; then
    return "$auth_status"
  fi
  if ! curl "${curl_args[@]}" --output "$release_json" "https://api.github.com/$api_path"; then
    echo "Unable to read GitHub release $tag from $GITHUB_REPOSITORY." >&2
    echo "For a private repository, install a repository-scoped fine-grained PAT at $GITHUB_TOKEN_FILE (root-owned, 0600)." >&2
    return 1
  fi

  mapfile -t release_assets < <("$CURRENT_PYTHON" - "$release_json" "$tag" <<'PY'
import json, re, sys
release = json.load(open(sys.argv[1], encoding="utf-8"))
tag = sys.argv[2]
version = tag[1:] if tag.startswith("v") else tag
pattern = re.compile(rf"^remote-agent-gateway-v{re.escape(version)}-[A-Za-z0-9._-]+-linux\\.tar\\.gz$")
assets = release.get("assets") or []
matches = [asset for asset in assets if pattern.fullmatch(asset.get("name", ""))]
if len(matches) != 1:
    raise SystemExit(f"expected exactly one Linux Runtime artifact for {tag}, found {len(matches)}")
artifact = matches[0]
checksum_name = artifact["name"] + ".sha256"
checksums = [asset for asset in assets if asset.get("name") == checksum_name]
if len(checksums) != 1:
    raise SystemExit(f"expected checksum asset {checksum_name}")
print(artifact["id"])
print(artifact["name"])
print(checksums[0]["id"])
print(checksum_name)
PY
  )
  [[ ${#release_assets[@]} -eq 4 ]] || return 1
  local artifact_id=${release_assets[0]} artifact_name=${release_assets[1]}
  local checksum_id=${release_assets[2]} checksum_name=${release_assets[3]}

  local asset_curl_args=(--fail --location --silent --show-error --retry 3 --retry-delay 1 -H 'Accept: application/octet-stream')
  [[ -f "$auth_config" ]] && asset_curl_args+=(--config "$auth_config")
  curl "${asset_curl_args[@]}" --output "$destination/$artifact_name" "https://api.github.com/repos/$GITHUB_REPOSITORY/releases/assets/$artifact_id"
  curl "${asset_curl_args[@]}" --output "$destination/$checksum_name" "https://api.github.com/repos/$GITHUB_REPOSITORY/releases/assets/$checksum_id"
  printf '%s\n' "$destination/$artifact_name"
}

current_target() {
  readlink -f "$CURRENT_LINK" 2>/dev/null || true
}

health_wait() {
  local attempt
  for attempt in $(seq 1 30); do
    if systemctl is-active --quiet "$SERVICE_NAME" && curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

backup_database() {
  local name=$1
  [[ -f "$GATEWAY_DATABASE" ]] || return 0
  local backup_dir="$GATEWAY_DATA_DIR/upgrade-backups"
  local backup_path="$backup_dir/$name.sqlite3"
  install -d -m 0700 -o "$GATEWAY_USER" -g "$GATEWAY_GROUP" "$backup_dir"
  "$CURRENT_PYTHON" - "$GATEWAY_DATABASE" "$backup_path" <<'PY'
import pathlib, sqlite3, sys
source = sqlite3.connect(sys.argv[1])
target = sqlite3.connect(sys.argv[2])
with target:
    source.backup(target)
source.close(); target.close()
pathlib.Path(sys.argv[2]).chmod(0o600)
PY
  chown "$GATEWAY_USER:$GATEWAY_GROUP" "$backup_path"
}

restore_database_backup() {
  local name=$1
  local backup_path="$GATEWAY_DATA_DIR/upgrade-backups/$name.sqlite3"
  [[ -f "$backup_path" ]] || return 0
  install -m 0600 -o "$GATEWAY_USER" -g "$GATEWAY_GROUP" "$backup_path" "$GATEWAY_DATABASE"
}

switch_release() {
  local target=$1
  [[ -x "$target/.venv/bin/python" ]] || { echo "Invalid release target: $target" >&2; return 1; }
  ln -sfn "$target" "$CURRENT_LINK"
}

prune_releases() {
  local current previous path
  current=$(current_target)
  previous=$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || true)
  while IFS= read -r path; do
    [[ "$path" == "$current" || "$path" == "$previous" ]] && continue
    rm -rf "$path"
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.staging-*' -print)
}

list_releases() {
  local current previous path marker
  current=$(current_target)
  previous=$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || true)
  printf '%-10s %s\n' STATE RELEASE
  while IFS= read -r path; do
    marker=""
    [[ "$path" == "$current" ]] && marker="current"
    [[ "$path" == "$previous" ]] && marker="${marker:+$marker,}previous"
    printf '%-10s %s\n' "${marker:--}" "$(basename "$path")"
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.staging-*' -print | sort)
}

if [[ "$COMMAND" == list ]]; then
  list_releases
  exit 0
fi

if [[ "$COMMAND" == rollback ]]; then
  old_current=$(current_target)
  [[ -n "$old_current" ]] || { echo "Current release is not set" >&2; exit 1; }
  target=$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || true)
  [[ -n "$target" && -d "$target" ]] || { echo "No rollback target is available" >&2; exit 1; }
  [[ "$target" != "$old_current" ]] || { echo "Rollback target is already current" >&2; exit 1; }

  systemctl stop "$SERVICE_NAME"
  switch_release "$target"
  ln -sfn "$old_current" "$PREVIOUS_LINK"
  systemctl start "$SERVICE_NAME"
  if ! health_wait; then
    echo "Rollback target failed health checks; restoring previous application release." >&2
    systemctl stop "$SERVICE_NAME" || true
    switch_release "$old_current"
    systemctl start "$SERVICE_NAME" || true
    exit 1
  fi
  echo "Rolled back application to $(basename "$target"). Database state was preserved."
  exit 0
fi

TMP_DIR=$(mktemp -d)
STAGING_RELEASE=
cleanup() {
  [[ -n "$STAGING_RELEASE" && -d "$STAGING_RELEASE" ]] && rm -rf "$STAGING_RELEASE"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [[ "$COMMAND" == github-install ]]; then
  echo "Downloading Remote Runtime release $RELEASE_TAG from $GITHUB_REPOSITORY"
  ARTIFACT=$(download_github_release "$RELEASE_TAG" "$TMP_DIR")
else
  ARTIFACT=$(cd "$(dirname "$ARG")" && pwd)/$(basename "$ARG")
  [[ -f "$ARTIFACT" ]] || { echo "Release artifact not found: $ARTIFACT" >&2; exit 1; }
fi

if [[ -f "$ARTIFACT.sha256" ]]; then
  "$CURRENT_PYTHON" - "$ARTIFACT" "$ARTIFACT.sha256" <<'PY'
import hashlib, pathlib, sys
artifact = pathlib.Path(sys.argv[1])
expected = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").split()[0]
actual = hashlib.sha256(artifact.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit("outer artifact checksum mismatch")
PY
fi

"$CURRENT_PYTHON" - "$ARTIFACT" "$TMP_DIR" <<'PY'
from __future__ import annotations
import pathlib, sys, tarfile

artifact = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2]).resolve()
with tarfile.open(artifact, "r:gz") as archive:
    members = archive.getmembers()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"unsafe archive path: {member.name}")
        if member.issym() or member.islnk() or member.isdev():
            raise SystemExit(f"unsupported archive member: {member.name}")
        resolved = (target / member.name).resolve()
        resolved.relative_to(target)
    for member in members:
        archive.extract(member, path=target, filter="data")
PY
MANIFEST=$(find "$TMP_DIR" -mindepth 2 -maxdepth 2 -name release.json -print -quit)
[[ -n "$MANIFEST" ]] || { echo "release.json is missing from artifact" >&2; exit 1; }
ROOT_DIR=$(dirname "$MANIFEST")
CHECKSUMS="$ROOT_DIR/SHA256SUMS.txt"
[[ -f "$CHECKSUMS" ]] || { echo "SHA256SUMS.txt is missing from artifact" >&2; exit 1; }

"$CURRENT_PYTHON" - "$ROOT_DIR" "$CHECKSUMS" <<'PY'
from __future__ import annotations
import hashlib, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
for line in pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    expected, relative = line.split(None, 1)
    relative = relative.lstrip("* ")
    path = (root / relative).resolve()
    path.relative_to(root)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"checksum mismatch: {relative}")
PY

RELEASE_ID=$(read_json_field "$MANIFEST" release_id)
VERSION=$(read_json_field "$MANIFEST" version)
PROJECT=$(read_json_field "$MANIFEST" project)
ARTIFACT_TYPE=$(read_json_field "$MANIFEST" artifact_type)
FORMAT_VERSION=$(read_json_field "$MANIFEST" format_version)
DIRTY=$(read_json_field "$MANIFEST" dirty)
[[ "$PROJECT" == "remote-agent-gateway" ]] || { echo "Unexpected release project: $PROJECT" >&2; exit 1; }
[[ "$ARTIFACT_TYPE" == "local-runtime" ]] || { echo "Unexpected artifact type: $ARTIFACT_TYPE" >&2; exit 1; }
[[ "$FORMAT_VERSION" == "1" ]] || { echo "Unsupported release format: $FORMAT_VERSION" >&2; exit 1; }
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid release_id in manifest" >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9A-Za-z._+-]+$ ]] || { echo "Invalid version in manifest" >&2; exit 1; }
if [[ "$DIRTY" == "True" && "$ALLOW_DIRTY" -ne 1 ]]; then
  echo "Refusing dirty development artifact; pass --allow-dirty only for an explicit smoke test." >&2
  exit 1
fi
WHEEL=$(find "$ROOT_DIR" -maxdepth 1 -type f -name 'remote_agent_gateway-*.whl' -print -quit)
[[ -n "$WHEEL" ]] || { echo "Release wheel is missing" >&2; exit 1; }
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
old_current=$(current_target)
if [[ "$old_current" == "$RELEASE_DIR" ]]; then
  echo "$RELEASE_ID is already current."
  exit 0
fi

if [[ ! -x "$RELEASE_DIR/.venv/bin/python" ]]; then
  STAGING_RELEASE="$RELEASES_DIR/.staging-${RELEASE_ID}-$$"
  install -d -m 0755 "$STAGING_RELEASE"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python "$CURRENT_PYTHON" "$STAGING_RELEASE/.venv" >/dev/null
    uv pip install --python "$STAGING_RELEASE/.venv/bin/python" "$WHEEL" >/dev/null
  else
    "$CURRENT_PYTHON" -m venv "$STAGING_RELEASE/.venv"
    "$STAGING_RELEASE/.venv/bin/python" -m pip install --upgrade pip >/dev/null
    "$STAGING_RELEASE/.venv/bin/python" -m pip install "$WHEEL" >/dev/null
  fi
  "$STAGING_RELEASE/.venv/bin/python" -c 'import gateway, remote_agent; print(gateway.__version__)' | grep -Fx "$VERSION" >/dev/null
  install -m 0644 "$MANIFEST" "$STAGING_RELEASE/release.json"
  chown -R root:root "$STAGING_RELEASE"
  chmod -R u=rwX,g=rX,o=rX "$STAGING_RELEASE"
  if [[ -e "$RELEASE_DIR" ]]; then
    rm -rf "$RELEASE_DIR"
  fi
  mv "$STAGING_RELEASE" "$RELEASE_DIR"
  STAGING_RELEASE=
fi

systemctl stop "$SERVICE_NAME"
backup_name="pre-${RELEASE_ID}"
backup_database "$backup_name"
if [[ -n "$old_current" ]]; then
  ln -sfn "$old_current" "$PREVIOUS_LINK"
fi
switch_release "$RELEASE_DIR"
systemctl start "$SERVICE_NAME"

if ! health_wait; then
  echo "Release $RELEASE_ID failed health checks; rolling back automatically." >&2
  systemctl stop "$SERVICE_NAME" || true
  if [[ -n "$old_current" ]]; then
    switch_release "$old_current"
  fi
  restore_database_backup "$backup_name"
  systemctl start "$SERVICE_NAME" || true
  health_wait || true
  exit 1
fi

# Refresh operator tooling only after the new application release passed health checks.
# A manual application rollback deliberately keeps these compatible operator tools.
if [[ -f "$ROOT_DIR/upgrade-local-runtime.sh" ]]; then
  install -m 0755 "$ROOT_DIR/upgrade-local-runtime.sh" /usr/local/sbin/remote-agent-upgrade
fi
if [[ -f "$ROOT_DIR/check-local-runtime.sh" ]]; then
  install -m 0755 "$ROOT_DIR/check-local-runtime.sh" /usr/local/sbin/remote-agent-doctor
fi

prune_releases
echo "Upgraded to $RELEASE_ID. Previous application release remains available for rollback."
