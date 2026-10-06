from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from gateway.agent_builder import PythonAgentBuilder
from remote_agent.core.version import AGENT_VERSION, CORE_VERSION


class AgentBuilderTests(unittest.TestCase):
    def test_python_bundle_contains_core_selected_profile_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            builder = PythonAgentBuilder(Path(directory))
            path, filename = builder.build(
                bundle_id="12345678-1234-1234-1234-123456789012",
                name="GPU Notebook",
                description="模型训练环境",
                profiles=["shell.v1"],
            )
            self.assertEqual(path.name, filename)
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                root = filename.removesuffix(".zip")
                self.assertIn(f"{root}/run.py", names)
                self.assertIn(f"{root}/remote_agent/core/runtime.py", names)
                self.assertIn(f"{root}/remote_agent/core/version.py", names)
                self.assertIn(f"{root}/remote_agent/profiles/registry.py", names)
                self.assertIn(f"{root}/remote_agent/profiles/common/filesystem.py", names)
                self.assertIn(f"{root}/remote_agent/profiles/shell_v1/__init__.py", names)
                self.assertIn(f"{root}/remote_agent/profiles/shell_v1/actions/exec.py", names)
                self.assertFalse(any("__pycache__" in name for name in names))
                self.assertFalse(any(name.endswith(".pyc") for name in names))
                self.assertIn(f"{root}/.gitignore", names)
                self.assertIn(f"{root}/github-actions.yml.example", names)
                self.assertIn(f"{root}/remote-agent.service.example", names)
                self.assertIn(f"{root}/Dockerfile.agent.example", names)
                self.assertIn(f"{root}/compose.agent.yml.example", names)
                manifest = json.loads(
                    archive.read(f"{root}/remote_agent/manifest.json").decode("utf-8")
                )
        self.assertEqual(manifest["profiles"], ["shell.v1"])
        self.assertEqual(manifest["agent_version"], AGENT_VERSION)
        self.assertEqual(manifest["core_version"], CORE_VERSION)
        self.assertEqual(manifest["build_id"], "12345678-1234-1234-1234-123456789012")
        self.assertEqual(manifest["agent"]["name"], "GPU Notebook")
        self.assertEqual(manifest["agent"]["description"], "模型训练环境")

    def test_python_bundle_contains_workspace_actions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            builder = PythonAgentBuilder(Path(directory))
            path, filename = builder.build(
                bundle_id="12345678-1234-1234-1234-123456789012",
                name="Workspace Agent",
                description="文本工作区",
                profiles=["workspace.v1"],
            )
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                root = filename.removesuffix(".zip")
        self.assertIn(f"{root}/remote_agent/profiles/workspace_v1/profile.py", names)
        self.assertIn(f"{root}/remote_agent/profiles/workspace_v1/actions/read.py", names)
        self.assertIn(f"{root}/remote_agent/profiles/workspace_v1/actions/write.py", names)
        self.assertIn(f"{root}/remote_agent/profiles/workspace_v1/actions/edit.py", names)

    def test_bundle_never_contains_enrollment_token(self) -> None:
        secret = "enroll_TEST_SECRET_SHOULD_NEVER_BE_PACKAGED_1234567890"
        with tempfile.TemporaryDirectory() as directory:
            builder = PythonAgentBuilder(Path(directory))
            path, _ = builder.build(
                bundle_id="12345678-1234-1234-1234-123456789012",
                name="Safe Agent",
                description="",
                profiles=["shell.v1"],
            )
            with zipfile.ZipFile(path) as archive:
                text = "\n".join(
                    archive.read(name).decode("utf-8", "ignore") for name in archive.namelist()
                )
        self.assertNotIn(secret, text)

    def test_bundle_documents_persistent_config_override(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            builder = PythonAgentBuilder(Path(directory))
            path, filename = builder.build(
                bundle_id="12345678-1234-1234-1234-123456789012",
                name="Persistent Agent",
                description="",
                profiles=["shell.v1"],
            )
            with zipfile.ZipFile(path) as archive:
                root = filename.removesuffix(".zip")
                readme = archive.read(f"{root}/README.txt").decode("utf-8")
        self.assertIn(".agent/config.json", readme)
        self.assertIn("--config", readme)
        self.assertIn("REMOTE_AGENT_CONFIG_B64", readme)
        self.assertIn("github-actions.yml.example", readme)
        self.assertIn("--workdir limits workspace.v1", readme)
        self.assertIn("NOT a shell sandbox", readme)
        self.assertIn("Standard local user", readme)
        self.assertIn("New-LocalUser", readme)
        self.assertIn("icacls", readme)
        self.assertIn("Do not add this account to Administrators", readme)
        self.assertIn("useradd --system", readme)
        self.assertIn("sudo -u remote-agent", readme)
        self.assertIn("docker compose -f compose.agent.yml.example run --rm", readme)
        self.assertIn(
            "--config /var/lib/remote-agent/config.json --workdir /workspace",
            readme,
        )

    def test_bundle_includes_guarded_github_actions_template(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            builder = PythonAgentBuilder(Path(directory))
            path, filename = builder.build(
                bundle_id="12345678-1234-1234-1234-123456789012",
                name="CI Runner",
                description="",
                profiles=["shell.v1"],
            )
            with zipfile.ZipFile(path) as archive:
                root = filename.removesuffix(".zip")
                workflow = archive.read(
                    f"{root}/github-actions.yml.example"
                ).decode("utf-8")
                gitignore = archive.read(f"{root}/.gitignore").decode("utf-8")

        self.assertIn("workflow_dispatch", workflow)
        self.assertIn("contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("timeout-minutes: 60", workflow)
        self.assertIn("cancel-in-progress: true", workflow)
        self.assertIn("secrets.REMOTE_AGENT_CONFIG_B64", workflow)
        self.assertIn("--config-env REMOTE_AGENT_CONFIG_B64", workflow)
        self.assertIn(root, workflow)
        self.assertIn(".agent/", gitignore)

    def test_bundle_includes_least_privilege_service_and_container_templates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            builder = PythonAgentBuilder(Path(directory))
            path, filename = builder.build(
                bundle_id="12345678-1234-1234-1234-123456789012",
                name="Production Agent",
                description="",
                profiles=["shell.v1"],
            )
            with zipfile.ZipFile(path) as archive:
                root = filename.removesuffix(".zip")
                systemd = archive.read(f"{root}/remote-agent.service.example").decode()
                dockerfile = archive.read(f"{root}/Dockerfile.agent.example").decode()
                compose = archive.read(f"{root}/compose.agent.yml.example").decode()

        self.assertIn("User=remote-agent", systemd)
        self.assertIn("NoNewPrivileges=true", systemd)
        self.assertIn("CapabilityBoundingSet=", systemd)
        self.assertIn("ReadWritePaths=/var/lib/remote-agent /srv/remote-agent-work", systemd)
        self.assertIn("USER 10001:10001", dockerfile)
        self.assertIn("read_only: true", compose)
        self.assertIn("cap_drop:", compose)
        self.assertIn("no-new-privileges:true", compose)

    def test_downloaded_bundle_launcher_is_runnable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            builder = PythonAgentBuilder(root)
            path, _ = builder.build(
                bundle_id="12345678-1234-1234-1234-123456789012",
                name="Runnable Agent",
                description="",
                profiles=["shell.v1"],
            )
            with zipfile.ZipFile(path) as archive:
                archive.extractall(root / "extracted")
            launcher = next((root / "extracted").rglob("run.py"))
            result = subprocess.run(
                [sys.executable, str(launcher), "--help"],
                cwd=launcher.parent,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--manifest", result.stdout)
        self.assertIn("--config-env", result.stdout)


if __name__ == "__main__":
    unittest.main()
