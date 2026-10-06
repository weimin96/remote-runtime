#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ALLOW_DIRTY=0

usage() {
  cat <<'USAGE'
Verify the current Remote Runtime checkout as a release candidate.

Usage:
  scripts/verify-release.sh [--allow-dirty]

Options:
  --allow-dirty  Allow tracked/untracked changes. Intended only while preparing a release.
USAGE
}

while (($#)); do
  case "$1" in
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$ROOT_DIR"

if [[ -x .venv/bin/python ]]; then
  PYTHON=.venv/bin/python
elif command -v python3 >/dev/null 2>&1; then
  PYTHON=$(command -v python3)
else
  echo "Python 3 is required. Create .venv and install the project first." >&2
  exit 1
fi

for command in git node npm; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command not found: $command" >&2
    exit 1
  }
done

if [[ ! -d apps/codex-remote-ssh/node_modules ]]; then
  echo "Remote SSH dependencies are missing. Run 'cd apps/codex-remote-ssh && npm ci' first." >&2
  exit 1
fi

if [[ "$ALLOW_DIRTY" -eq 0 && -n "$(git status --porcelain)" ]]; then
  echo "Release verification requires a clean worktree. Commit/stash changes or use --allow-dirty while preparing the release." >&2
  exit 1
fi

echo "== Python tests =="
"$PYTHON" -m unittest discover -q

echo "== Python compile =="
"$PYTHON" -m compileall -q gateway remote_agent agent.py tests

echo "== Gateway static JavaScript =="
node --check gateway/static/app.js

echo "== Remote SSH =="
FRESH_NPM_DIR=$(mktemp -d "${TMPDIR:-/tmp}/remote-ssh-npm-ci.XXXXXX")
mkdir -p "$FRESH_NPM_DIR/codex-remote-ssh" "$FRESH_NPM_DIR/cache"
cp apps/codex-remote-ssh/package.json apps/codex-remote-ssh/package-lock.json "$FRESH_NPM_DIR/codex-remote-ssh/"
(
  cd "$FRESH_NPM_DIR/codex-remote-ssh"
  npm ci \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --cache "$FRESH_NPM_DIR/cache" \
    --registry=https://registry.npmjs.org
)
rm -rf "$FRESH_NPM_DIR"
npm --prefix apps/codex-remote-ssh run check

echo "== Git whitespace =="
git diff --check

echo "== Reproducible release artifact =="
FIRST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/remote-runtime-release-first.XXXXXX")
SECOND_DIR=$(mktemp -d "${TMPDIR:-/tmp}/remote-runtime-release-second.XXXXXX")
cleanup() {
  rm -rf "$FIRST_DIR" "$SECOND_DIR"
}
trap cleanup EXIT

BUILD_ARGS=()
if [[ "$ALLOW_DIRTY" -eq 1 ]]; then
  BUILD_ARGS+=(--allow-dirty)
fi
"$PYTHON" tools/build_local_release.py --output-dir "$FIRST_DIR" "${BUILD_ARGS[@]}" >/dev/null
"$PYTHON" tools/build_local_release.py --output-dir "$SECOND_DIR" "${BUILD_ARGS[@]}" >/dev/null
"$PYTHON" tools/build_remote_ssh_release.py --output-dir "$FIRST_DIR" "${BUILD_ARGS[@]}" >/dev/null
"$PYTHON" tools/build_remote_ssh_release.py --output-dir "$SECOND_DIR" "${BUILD_ARGS[@]}" >/dev/null

"$PYTHON" - "$FIRST_DIR" "$SECOND_DIR" <<'PY'
from __future__ import annotations

import hashlib
import sys
from pathlib import Path


def hashes(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(root.iterdir()):
        if not path.is_file():
            continue
        result[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


first = hashes(Path(sys.argv[1]))
second = hashes(Path(sys.argv[2]))
if first != second:
    print("Release artifacts are not reproducible.", file=sys.stderr)
    print(f"first={first}", file=sys.stderr)
    print(f"second={second}", file=sys.stderr)
    raise SystemExit(1)

print("Reproducible artifacts:")
for name, digest in first.items():
    print(f"  {digest}  {name}")
PY

echo "Release candidate verification passed."
