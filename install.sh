#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="weimin96/remote-runtime"
REF="${REMOTE_RUNTIME_REF:-main}"
INSTALL_ARGS=()

usage() {
  cat <<'USAGE'
Bootstrap Remote Runtime from GitHub and delegate to the systemd Linux installer.

Public repository:
  curl -fsSL https://raw.githubusercontent.com/weimin96/remote-runtime/main/install.sh \
    | bash -s -- \
      --public-url https://runtime.example.com \
      --owner-email owner@example.com

Bootstrap options:
  --ref REF          Install a specific Git ref (default: main)
  --version VERSION  Install tag vVERSION, for example --version 0.99.9
  --bootstrap-help   Show this bootstrap help without downloading source

All other options are forwarded unchanged to deploy/install-local-runtime.sh.
USAGE
}

while (($#)); do
  case "$1" in
    --ref)
      REF=${2:?missing ref}
      shift 2
      ;;
    --version)
      VERSION=${2:?missing version}
      REF="v${VERSION#v}"
      shift 2
      ;;
    --bootstrap-help)
      usage
      exit 0
      ;;
    *)
      INSTALL_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Remote Runtime local execution mode currently supports systemd Linux hosts only." >&2
  exit 1
fi

for command in curl tar mktemp bash awk; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command not found: $command" >&2
    exit 1
  }
done
if [[ ${EUID:-$(id -u)} -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required when bootstrap is not already running as root." >&2
  exit 1
fi

if [[ ! "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ || "$REF" == *".."* || "$REF" == */ || "$REF" == /* ]]; then
  echo "Invalid Git ref: $REF" >&2
  exit 2
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/remote-runtime-install.XXXXXX")
ARCHIVE="$TMP_DIR/source.tar.gz"
SOURCE_DIR="$TMP_DIR/source"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

SOURCE_URL="https://codeload.github.com/$REPOSITORY/tar.gz/$REF"
echo "Downloading Remote Runtime source: $REPOSITORY@$REF"
DOWNLOADED=0
if command -v gh >/dev/null 2>&1; then
  if gh api "repos/$REPOSITORY/tarball/$REF" >"$ARCHIVE" 2>"$TMP_DIR/gh-error.log"; then
    DOWNLOADED=1
  fi
fi

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
unset GH_TOKEN GITHUB_TOKEN
if [[ "$DOWNLOADED" -eq 0 && -n "$TOKEN" ]]; then
  CURL_CONFIG="$TMP_DIR/curl-auth.conf"
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" >"$CURL_CONFIG"
  chmod 0600 "$CURL_CONFIG"
  if curl \
    --config "$CURL_CONFIG" \
    --fail \
    --location \
    --silent \
    --show-error \
    --retry 3 \
    --retry-delay 1 \
    --output "$ARCHIVE" \
    "https://api.github.com/repos/$REPOSITORY/tarball/$REF"; then
    DOWNLOADED=1
  fi
  rm -f "$CURL_CONFIG"
fi
TOKEN=

if [[ "$DOWNLOADED" -eq 0 ]]; then
  if curl \
    --fail \
    --location \
    --silent \
    --show-error \
    --retry 3 \
    --retry-delay 1 \
    --output "$ARCHIVE" \
    "$SOURCE_URL"; then
    DOWNLOADED=1
  fi
fi

if [[ "$DOWNLOADED" -eq 0 ]]; then
  echo "Unable to download $REPOSITORY@$REF." >&2
  echo "Check the repository/ref and network access. Private mirrors may use gh auth or GH_TOKEN/GITHUB_TOKEN." >&2
  exit 1
fi

if ! tar -tzf "$ARCHIVE" | awk '
  BEGIN { bad = 0 }
  /^\// { bad = 1 }
  /(^|\/)\.\.($|\/)/ { bad = 1 }
  END { exit bad }
'; then
  echo "Downloaded source archive contains an unsafe path." >&2
  exit 1
fi

mkdir -p "$SOURCE_DIR"
tar -xzf "$ARCHIVE" -C "$SOURCE_DIR" --strip-components=1

INNER_INSTALLER="$SOURCE_DIR/deploy/install-local-runtime.sh"
if [[ ! -f "$SOURCE_DIR/pyproject.toml" || ! -f "$INNER_INSTALLER" ]]; then
  echo "Downloaded source archive is not a valid Remote Runtime checkout." >&2
  exit 1
fi

echo "Installing Remote Runtime from $REF"
if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  bash "$INNER_INSTALLER" --source-dir "$SOURCE_DIR" "${INSTALL_ARGS[@]}"
else
  sudo bash "$INNER_INSTALLER" --source-dir "$SOURCE_DIR" "${INSTALL_ARGS[@]}"
fi

