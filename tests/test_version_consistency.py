from __future__ import annotations

import json
import re
import tomllib
import unittest
from pathlib import Path

import gateway
import remote_agent
from remote_agent.core.version import AGENT_VERSION, CORE_VERSION, PROTOCOL_VERSION


class VersionConsistencyTests(unittest.TestCase):
    def test_all_public_version_sources_are_synchronized(self) -> None:
        root = Path(__file__).resolve().parents[1]
        project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
        version = project["project"]["version"]
        manifest = json.loads(
            (root / "remote_agent" / "manifest.json").read_text(encoding="utf-8")
        )
        remote_ssh_package = json.loads(
            (root / "apps" / "codex-remote-ssh" / "package.json").read_text(encoding="utf-8")
        )
        remote_ssh_lock = json.loads(
            (root / "apps" / "codex-remote-ssh" / "package-lock.json").read_text(
                encoding="utf-8"
            )
        )
        remote_ssh_plugin = json.loads(
            (
                root
                / "apps"
                / "codex-remote-ssh"
                / ".codex-plugin"
                / "plugin.json"
            ).read_text(encoding="utf-8")
        )
        remote_ssh_server = (
            root / "apps" / "codex-remote-ssh" / "src" / "server" / "index.ts"
        ).read_text(encoding="utf-8")
        remote_ssh_app = (
            root / "apps" / "codex-remote-ssh" / "src" / "app" / "index.tsx"
        ).read_text(encoding="utf-8")
        readme = (root / "README.md").read_text(encoding="utf-8")
        index = (root / "gateway" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertEqual(gateway.__version__, version)
        self.assertEqual(remote_agent.__version__, version)
        self.assertEqual(AGENT_VERSION, version)
        self.assertEqual(manifest["agent_version"], version)
        self.assertEqual(manifest["core_version"], CORE_VERSION)
        self.assertEqual(remote_ssh_package["version"], version)
        self.assertEqual(remote_ssh_lock["version"], version)
        self.assertEqual(remote_ssh_lock["packages"][""]["version"], version)
        self.assertEqual(remote_ssh_plugin["version"], version)
        self.assertIn(f'version: "{version}"', remote_ssh_server)
        self.assertIn(f'version: "{version}"', remote_ssh_app)
        self.assertIn("img.shields.io/github/v/release/weimin96/remote-runtime", readme)
        self.assertEqual(
            re.findall(r'/assets/(?:styles\.css|app\.js)\?v=([^"\s]+)', index),
            [version, version],
        )


if __name__ == "__main__":
    unittest.main()
