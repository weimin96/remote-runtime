#!/usr/bin/env bash
set -euo pipefail

REPOSITORY=${REMOTE_RUNTIME_GITHUB_REPOSITORY:-weimin96/remote-runtime}
INSTALL_DIR=${REMOTE_SSH_INSTALL_DIR:-$HOME/.local/share/remote-runtime/remote-ssh-marketplace}
VERSION=

usage() {
  cat <<'USAGE'
Install the prebuilt Remote SSH Codex plugin from a GitHub Release.

Usage:
  curl -fsSL https://raw.githubusercontent.com/weimin96/remote-runtime/main/install-remote-ssh.sh | bash
  install-remote-ssh.sh --version VERSION [--install-dir DIR]

Options:
  --version VERSION   Install a specific release. Defaults to the newest published release,
                      including prereleases while Remote Runtime is on the 0.x RC line.
  --install-dir DIR   Local marketplace root (default: ~/.local/share/remote-runtime/remote-ssh-marketplace)
  -h, --help          Show this help.

The installer downloads a prebuilt platform artifact. It does not clone the repository,
run npm install, or compile node-pty on the user's machine.
USAGE
}

while (($#)); do
  case "$1" in
    --version)
      VERSION=${2:?missing version}
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR=${2:?missing directory}
      shift 2
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

for command in curl tar node codex; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command not found: $command" >&2
    exit 1
  }
done

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [[ ! "$node_major" =~ ^[0-9]+$ || "$node_major" -lt 22 ]]; then
  echo "Remote SSH requires Node.js 22 or newer." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *)
    echo "Remote SSH prebuilt installation currently supports macOS and Linux." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *)
    echo "Unsupported CPU architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
platform="$os-$arch"

if [[ "$platform" == "linux-arm64" ]]; then
  echo "A prebuilt Linux arm64 Remote SSH package is not published yet." >&2
  exit 1
fi

[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "Invalid GitHub repository: $REPOSITORY" >&2
  exit 2
}
if [[ -n "$VERSION" && ! "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$ ]]; then
  echo "Invalid version: $VERSION" >&2
  exit 2
fi

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/remote-ssh-install.XXXXXX")
staged_dir="${INSTALL_DIR}.new.$$"
backup_dir="${INSTALL_DIR}.old.$$"
cleanup() {
  rm -rf "$temp_dir" "$staged_dir"
}
trap cleanup EXIT

if [[ -n "$VERSION" ]]; then
  tag="v${VERSION#v}"
  release_url="https://api.github.com/repos/$REPOSITORY/releases/tags/$tag"
else
  release_url="https://api.github.com/repos/$REPOSITORY/releases?per_page=1"
fi

release_json="$temp_dir/release.json"
curl --fail --location --silent --show-error --retry 3 --retry-delay 1 \
  --output "$release_json" "$release_url"

mapfile_compat() {
  local output=$1
  shift
  "$@" >"$output"
}

selection="$temp_dir/selection.txt"
mapfile_compat "$selection" node - "$release_json" "$platform" <<'NODE'
const fs = require("fs");
const [path, platform] = process.argv.slice(2);
const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
const release = Array.isArray(parsed) ? parsed[0] : parsed;
if (!release || release.draft) throw new Error("No published release was found");
const tag = String(release.tag_name || "");
const version = tag.startsWith("v") ? tag.slice(1) : tag;
const prefix = `remote-ssh-v${version}-`;
const suffix = `-${platform}.tar.gz`;
const assets = Array.isArray(release.assets) ? release.assets : [];
const matches = assets.filter((asset) => {
  const name = String(asset.name || "");
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  const buildId = name.slice(prefix.length, -suffix.length);
  return /^[A-Za-z0-9._-]+$/.test(buildId);
});
if (matches.length !== 1) {
  throw new Error(`Expected exactly one Remote SSH ${platform} artifact for ${tag}, found ${matches.length}`);
}
const artifact = matches[0];
const checksumName = `${artifact.name}.sha256`;
const checksums = assets.filter((asset) => asset.name === checksumName);
if (checksums.length !== 1) throw new Error(`Missing checksum asset ${checksumName}`);
console.log(tag);
console.log(artifact.name);
console.log(artifact.url);
console.log(checksumName);
console.log(checksums[0].url);
NODE

tag=$(sed -n '1p' "$selection")
artifact_name=$(sed -n '2p' "$selection")
artifact_url=$(sed -n '3p' "$selection")
checksum_name=$(sed -n '4p' "$selection")
checksum_url=$(sed -n '5p' "$selection")
[[ -n "$tag" && -n "$artifact_name" && -n "$artifact_url" && -n "$checksum_name" && -n "$checksum_url" ]] || {
  echo "GitHub release metadata was incomplete." >&2
  exit 1
}

echo "Downloading Remote SSH $tag for $platform"
curl --fail --location --silent --show-error --retry 3 --retry-delay 1 \
  -H 'Accept: application/octet-stream' \
  --output "$temp_dir/$artifact_name" "$artifact_url"
curl --fail --location --silent --show-error --retry 3 --retry-delay 1 \
  -H 'Accept: application/octet-stream' \
  --output "$temp_dir/$checksum_name" "$checksum_url"

expected=$(awk 'NR == 1 {print $1}' "$temp_dir/$checksum_name")
[[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || {
  echo "Invalid release checksum." >&2
  exit 1
}
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temp_dir/$artifact_name" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temp_dir/$artifact_name" | awk '{print $1}')
else
  echo "sha256sum or shasum is required." >&2
  exit 1
fi
actual_lower=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')
expected_lower=$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')
[[ "$actual_lower" == "$expected_lower" ]] || {
  echo "Remote SSH artifact checksum mismatch." >&2
  exit 1
}

if tar -tzf "$temp_dir/$artifact_name" | awk '
  /^\// { bad=1 }
  /(^|\/)\.\.(\/|$)/ { bad=1 }
  END { exit bad ? 0 : 1 }
'; then
  echo "Release archive contains an unsafe path." >&2
  exit 1
fi

extract_dir="$temp_dir/extract"
mkdir -p "$extract_dir"
tar -xzf "$temp_dir/$artifact_name" -C "$extract_dir"
mapfile_compat "$temp_dir/roots.txt" find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -print
root_count=$(wc -l <"$temp_dir/roots.txt" | tr -d ' ')
[[ "$root_count" == 1 ]] || {
  echo "Release archive must contain exactly one root directory." >&2
  exit 1
}
release_root=$(sed -n '1p' "$temp_dir/roots.txt")
[[ -f "$release_root/release.json" && -f "$release_root/.agents/plugins/marketplace.json" ]] || {
  echo "Remote SSH release metadata is missing." >&2
  exit 1
}

node - "$release_root/release.json" "$tag" "$platform" <<'NODE'
const fs = require("fs");
const [path, tag, platform] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
const version = tag.startsWith("v") ? tag.slice(1) : tag;
if (manifest.project !== "remote-runtime") throw new Error("Unexpected release project");
if (manifest.artifact_type !== "codex-remote-ssh") throw new Error("Unexpected artifact type");
if (manifest.version !== version) throw new Error("Release version mismatch");
if (manifest.platform !== platform) throw new Error("Release platform mismatch");
if (manifest.dirty !== false) throw new Error("Refusing dirty development artifact");
NODE

mkdir -p "$(dirname "$INSTALL_DIR")"
rm -rf "$staged_dir" "$backup_dir"
mv "$release_root" "$staged_dir"
if [[ -e "$INSTALL_DIR" ]]; then
  mv "$INSTALL_DIR" "$backup_dir"
fi
mv "$staged_dir" "$INSTALL_DIR"

restore_previous() {
  rm -rf "$INSTALL_DIR"
  if [[ -e "$backup_dir" ]]; then
    mv "$backup_dir" "$INSTALL_DIR"
  fi
}

marketplaces_json="$temp_dir/marketplaces.json"
previous_marketplace_root=
previous_marketplace_source=
if codex plugin marketplace list --json >"$marketplaces_json" 2>/dev/null; then
  marketplace_state="$temp_dir/marketplace-state.txt"
  node - "$marketplaces_json" >"$marketplace_state" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
const marketplaces = Array.isArray(parsed.marketplaces) ? parsed.marketplaces : [];
const entry = marketplaces.find((item) => item && item.name === "remote-agent");
if (entry) {
  console.log(String(entry.root || ""));
  console.log(String(entry.marketplaceSource?.source || entry.root || ""));
}
NODE
  previous_marketplace_root=$(sed -n '1p' "$marketplace_state")
  previous_marketplace_source=$(sed -n '2p' "$marketplace_state")
fi

marketplace_changed=0
restore_marketplace() {
  if [[ "$marketplace_changed" != 1 ]]; then
    return 0
  fi
  codex plugin marketplace remove remote-agent --json >/dev/null 2>&1 || true
  if [[ -n "$previous_marketplace_source" ]]; then
    codex plugin marketplace add "$previous_marketplace_source" --json >/dev/null 2>&1 || true
  fi
}

if [[ -n "$previous_marketplace_root" && "$previous_marketplace_root" != "$INSTALL_DIR" ]]; then
  if ! codex plugin marketplace remove remote-agent --json >/dev/null; then
    restore_previous
    echo "Failed to replace the existing remote-agent marketplace registration." >&2
    exit 1
  fi
  marketplace_changed=1
fi

if [[ "$previous_marketplace_root" != "$INSTALL_DIR" ]]; then
  marketplace_changed=1
  if ! codex plugin marketplace add "$INSTALL_DIR" --json; then
    restore_previous
    restore_marketplace
    echo "Failed to register the Remote Runtime marketplace." >&2
    exit 1
  fi
fi
if ! codex plugin add remote-ssh@remote-agent --json; then
  restore_previous
  restore_marketplace
  echo "Failed to install remote-ssh@remote-agent." >&2
  exit 1
fi

rm -rf "$backup_dir"
trap - EXIT
rm -rf "$temp_dir"
echo "Remote SSH $tag installed from a prebuilt $platform release."
echo "Start a new Codex thread to use the updated plugin runtime."
