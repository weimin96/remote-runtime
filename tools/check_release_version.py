from __future__ import annotations

import argparse
import json
import pathlib
import re
import tomllib


ROOT = pathlib.Path(__file__).resolve().parents[1]


def read_versions() -> dict[str, str]:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    package = json.loads((ROOT / "apps/codex-remote-ssh/package.json").read_text(encoding="utf-8"))
    package_lock = json.loads(
        (ROOT / "apps/codex-remote-ssh/package-lock.json").read_text(encoding="utf-8")
    )
    plugin = json.loads(
        (ROOT / "apps/codex-remote-ssh/.codex-plugin/plugin.json").read_text(encoding="utf-8")
    )
    agent_manifest = json.loads((ROOT / "remote_agent/manifest.json").read_text(encoding="utf-8"))
    agent_source = (ROOT / "remote_agent/core/version.py").read_text(encoding="utf-8")
    agent_match = re.search(r'^AGENT_VERSION = "([^"]+)"$', agent_source, re.MULTILINE)
    if agent_match is None:
        raise SystemExit("AGENT_VERSION was not found")
    gateway_source = (ROOT / "gateway/__init__.py").read_text(encoding="utf-8")
    gateway_match = re.search(r'^__version__ = "([^"]+)"$', gateway_source, re.MULTILINE)
    if gateway_match is None:
        raise SystemExit("gateway __version__ was not found")
    agent_init_source = (ROOT / "remote_agent/__init__.py").read_text(encoding="utf-8")
    agent_init_match = re.search(r'^__version__ = "([^"]+)"$', agent_init_source, re.MULTILINE)
    if agent_init_match is None:
        raise SystemExit("remote_agent __version__ was not found")
    app_source = (ROOT / "apps/codex-remote-ssh/src/app/index.tsx").read_text(encoding="utf-8")
    app_match = re.search(r'appInfo: \{ name: "remote-ssh", version: "([^"]+)" \}', app_source)
    if app_match is None:
        raise SystemExit("Remote SSH app version was not found")
    server_source = (ROOT / "apps/codex-remote-ssh/src/server/index.ts").read_text(encoding="utf-8")
    server_match = re.search(r'^  version: "([^"]+)",$', server_source, re.MULTILINE)
    if server_match is None:
        raise SystemExit("Remote SSH server version was not found")
    return {
        "project": project["project"]["version"],
        "gateway": gateway_match.group(1),
        "remote-ssh": package["version"],
        "remote-ssh-lock": package_lock["version"],
        "remote-ssh-lock-root": package_lock["packages"][""]["version"],
        "plugin": plugin["version"],
        "agent": agent_match.group(1),
        "agent-package": agent_init_match.group(1),
        "agent-manifest": agent_manifest["agent_version"],
        "remote-ssh-app": app_match.group(1),
        "remote-ssh-server": server_match.group(1),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify that release version sources match a tag")
    parser.add_argument("tag", nargs="?", help="Expected tag, for example v0.99.11")
    args = parser.parse_args()

    versions = read_versions()
    unique = set(versions.values())
    if len(unique) != 1:
        raise SystemExit(f"version sources disagree: {versions}")
    version = next(iter(unique))
    if args.tag is not None and args.tag != f"v{version}":
        raise SystemExit(f"tag {args.tag!r} does not match project version v{version}")
    print(version)


if __name__ == "__main__":
    main()
