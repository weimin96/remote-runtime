#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=/etc/remote-agent-gateway.env
SERVICE_NAME=remote-agent-gateway
RUNTIME_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PROJECT_HELPER=/usr/local/bin/remote-project

usage() {
  cat <<'USAGE'
Read-only verification for a local Remote Runtime deployment.

Usage:
  sudo ./deploy/check-local-runtime.sh [--env-file PATH] [--service NAME]

Checks systemd state, loopback binding, local health, runner identity,
control-plane file isolation, workspace roots, and public OAuth discovery.
No passwords, MFA secrets, OAuth tokens, or database contents are printed.
USAGE
}

while (($#)); do
  case "$1" in
    --env-file) ENV_FILE=${2:?missing path}; shift 2 ;;
    --service) SERVICE_NAME=${2:?missing service}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "This check must run as root." >&2
  exit 1
fi
[[ -r "$ENV_FILE" ]] || { echo "FAIL env file is not readable: $ENV_FILE" >&2; exit 1; }
for command in systemctl sudo curl id sed; do
  command -v "$command" >/dev/null 2>&1 || { echo "FAIL required command not found: $command" >&2; exit 1; }
done

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${GATEWAY_HOST:?missing GATEWAY_HOST}"
: "${GATEWAY_PORT:?missing GATEWAY_PORT}"
: "${GATEWAY_PUBLIC_URL:?missing GATEWAY_PUBLIC_URL}"
: "${GATEWAY_DATA_DIR:?missing GATEWAY_DATA_DIR}"
: "${GATEWAY_LOCAL_WORKDIR:?missing GATEWAY_LOCAL_WORKDIR}"
: "${GATEWAY_LOCAL_EXEC_USER:?missing GATEWAY_LOCAL_EXEC_USER}"

FAILURES=0
pass() { printf 'PASS %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

if systemctl is-active --quiet "$SERVICE_NAME"; then
  pass "$SERVICE_NAME is active"
else
  fail "$SERVICE_NAME is not active"
fi

SERVICE_EXEC=$(systemctl show "$SERVICE_NAME" -p ExecStart 2>/dev/null || true)
APP_DIR=$(systemctl show "$SERVICE_NAME" -p WorkingDirectory 2>/dev/null | sed -n 's/^WorkingDirectory=//p')
if [[ -n "$APP_DIR" && "$SERVICE_EXEC" == *"$APP_DIR/current/.venv/bin/python"* ]]; then
  CURRENT_LINK="$APP_DIR/current"
  RELEASES_DIR="$APP_DIR/releases"
  CURRENT_TARGET=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
  if [[ -n "$CURRENT_TARGET" && "$CURRENT_TARGET" == "$RELEASES_DIR"/* && -x "$CURRENT_TARGET/.venv/bin/python" ]]; then
    pass "managed current release is $(basename "$CURRENT_TARGET")"
    if [[ -f "$CURRENT_TARGET/release.json" ]]; then
      pass "current release manifest is present"
    else
      warn "current release has no release.json (older managed install)"
    fi
  else
    fail "managed current link is invalid or escapes releases directory"
  fi
else
  warn "service is not using managed current/.venv layout"
fi

GATEWAY_USER=$(
  systemctl show "$SERVICE_NAME" -p User 2>/dev/null \
    | sed -n 's/^User=//p'
)
if [[ -n "$GATEWAY_USER" ]]; then
  pass "control user is $GATEWAY_USER"
else
  fail "could not resolve systemd User for $SERVICE_NAME"
fi

if [[ -x "$PROJECT_HELPER" ]]; then
  if sudo -u "$GATEWAY_LOCAL_EXEC_USER" "$PROJECT_HELPER" inspect "$GATEWAY_LOCAL_WORKDIR" >/dev/null 2>&1; then
    pass "remote-project helper is available to runner"
  else
    fail "remote-project helper cannot inspect primary workspace"
  fi
else
  warn "remote-project helper is not installed"
fi

if TMUX_BIN=$(PATH="$RUNTIME_PATH" command -v tmux 2>/dev/null); then
  if [[ -n "$GATEWAY_USER" ]] && sudo -u "$GATEWAY_USER" sudo -n -u "$GATEWAY_LOCAL_EXEC_USER" -- "$TMUX_BIN" -V >/dev/null 2>&1; then
    pass "persistent tmux backend is available"
  else
    fail "tmux exists but Gateway sudoers cannot execute it as runner"
  fi
else
  warn "tmux is not installed; persistent=true is unavailable"
fi

case "$GATEWAY_HOST" in
  127.0.0.1|localhost|::1) pass "Gateway bind is loopback ($GATEWAY_HOST)" ;;
  *) fail "Gateway bind is not loopback: $GATEWAY_HOST" ;;
esac

LOCAL_HTTP_HOST=127.0.0.1
[[ "$GATEWAY_HOST" == "::1" ]] && LOCAL_HTTP_HOST='[::1]'
if curl -fsS "http://${LOCAL_HTTP_HOST}:${GATEWAY_PORT}/api/health" >/dev/null; then
  pass "local health endpoint"
else
  fail "local health endpoint"
fi

if [[ -n "$GATEWAY_USER" ]]; then
  if sudo -u "$GATEWAY_USER" sudo -n -u "$GATEWAY_LOCAL_EXEC_USER" -- id -u >/dev/null 2>&1; then
    pass "control user can switch only into configured runner path"
  else
    fail "control user cannot execute as runner; check sudoers"
  fi
fi

if sudo -u "$GATEWAY_LOCAL_EXEC_USER" test -r "$ENV_FILE"; then
  fail "runner can read control env file"
else
  pass "runner cannot read control env file"
fi

DATABASE=${GATEWAY_DATABASE:-$GATEWAY_DATA_DIR/gateway.db}
if [[ -e "$DATABASE" ]]; then
  if sudo -u "$GATEWAY_LOCAL_EXEC_USER" test -r "$DATABASE"; then
    fail "runner can read Gateway database"
  else
    pass "runner cannot read Gateway database"
  fi
else
  fail "Gateway database does not exist: $DATABASE"
fi

ROOTS=("$GATEWAY_LOCAL_WORKDIR")
if [[ -n "${GATEWAY_LOCAL_WORKDIRS:-}" ]]; then
  IFS=: read -r -a EXTRA_ROOTS <<< "$GATEWAY_LOCAL_WORKDIRS"
  ROOTS+=("${EXTRA_ROOTS[@]}")
fi
for root in "${ROOTS[@]}"; do
  [[ -n "$root" ]] || continue
  if [[ ! -d "$root" ]]; then
    fail "workspace root does not exist: $root"
    continue
  fi
  if [[ -n "$GATEWAY_USER" ]] && ! sudo -u "$GATEWAY_USER" test -x "$root"; then
    fail "control user cannot traverse workspace root: $root"
    continue
  fi
  if ! sudo -u "$GATEWAY_LOCAL_EXEC_USER" test -x "$root"; then
    fail "runner cannot traverse workspace root: $root"
    continue
  fi
  pass "workspace root accessible: $root"
done

if [[ "$GATEWAY_PUBLIC_URL" == https://* ]]; then
  if curl -fsS --max-time 10 "$GATEWAY_PUBLIC_URL/.well-known/oauth-authorization-server" >/dev/null; then
    pass "public OAuth discovery"
  else
    warn "public OAuth discovery is not reachable from this host; verify DNS/reverse proxy/tunnel separately"
  fi
else
  warn "public URL is not HTTPS: $GATEWAY_PUBLIC_URL"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "Doctor found $FAILURES blocking issue(s)." >&2
  exit 1
fi

echo "Doctor completed without blocking issues."
