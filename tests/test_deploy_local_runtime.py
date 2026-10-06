from __future__ import annotations

import subprocess
import stat
import unittest
from pathlib import Path


class LocalRuntimeDeploymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(__file__).resolve().parents[1]
        cls.bootstrap = cls.root / "install.sh"
        cls.installer = cls.root / "deploy" / "install-local-runtime.sh"

    def test_bootstrap_has_valid_bash_syntax_and_delegates_to_installer(self) -> None:
        result = subprocess.run(
            ["bash", "-n", str(self.bootstrap)],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        text = self.bootstrap.read_text(encoding="utf-8")
        self.assertIn('REPOSITORY="weimin96/remote-runtime"', text)
        self.assertIn('REF="${REMOTE_RUNTIME_REF:-main}"', text)
        self.assertIn("https://codeload.github.com/$REPOSITORY/tar.gz/$REF", text)
        self.assertIn('gh api "repos/$REPOSITORY/tarball/$REF"', text)
        self.assertIn('TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"', text)
        self.assertIn("unset GH_TOKEN GITHUB_TOKEN", text)
        self.assertIn('sudo bash "$INNER_INSTALLER"', text)
        self.assertIn('bash "$INNER_INSTALLER" --source-dir "$SOURCE_DIR" "${INSTALL_ARGS[@]}"', text)
        self.assertIn("Downloaded source archive contains an unsafe path.", text)
        self.assertIn("curl tar mktemp bash awk", text)
        self.assertIn("--version", text)
        self.assertIn("--ref", text)
        self.assertIn("--strip-components=1", text)

    def test_installer_has_valid_bash_syntax(self) -> None:
        result = subprocess.run(
            ["bash", "-n", str(self.installer)],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_installer_is_host_agnostic(self) -> None:
        text = self.installer.read_text(encoding="utf-8")
        self.assertIn("APP_DIR=/opt/remote-agent", text)
        self.assertNotIn("APP_DIR=/opt/remote-agent-gateway", text)
        self.assertIn("--public-url", text)
        self.assertIn("--workdir", text)
        self.assertIn("--allow-workdir", text)
        self.assertIn("--runner-user", text)
        self.assertIn("--control-group", text)
        self.assertIn("/usr/local/bin/remote-project", text)
        self.assertIn("command -v tmux", text)
        self.assertIn("Environment=PATH=", text)
        self.assertIn('RELEASES_DIR="$APP_DIR/releases"', text)
        self.assertIn('CURRENT_LINK="$APP_DIR/current"', text)
        self.assertIn('PREVIOUS_LINK="$APP_DIR/previous"', text)
        self.assertIn("SOURCE_FINGERPRINT", text)
        self.assertIn("automatic rollback", text)
        self.assertIn("--env-file", text)
        self.assertIn("--service", text)
        self.assertIn('if ((${#ALLOW_WORKDIRS[@]})); then', text)
        self.assertNotIn("uv venv --seed", text)
        self.assertIn("flock -n 9", text)
        self.assertIn(".staging-*", text)
        self.assertIn('"artifact_type": "source-runtime"', text)
        self.assertIn("source_fingerprint", text)
        self.assertIn("/usr/local/sbin/remote-agent-upgrade", text)
        self.assertIn("/usr/local/sbin/remote-agent-doctor", text)

    def test_installer_keeps_control_and_workspace_groups_separate(self) -> None:
        text = self.installer.read_text(encoding="utf-8")
        self.assertIn('usermod -aG "$WORKSPACE_GROUP","$CONTROL_GROUP" "$GATEWAY_USER"', text)
        self.assertIn('usermod -aG "$WORKSPACE_GROUP" "$RUNNER_USER"', text)
        self.assertNotIn('usermod -aG "$CONTROL_GROUP" "$RUNNER_USER"', text)
        self.assertIn('sudo -u "$RUNNER_USER" test -r "$ENV_FILE"', text)

    def test_reverse_proxy_examples_do_not_publish_admin_ui(self) -> None:
        caddy = (self.root / "deploy" / "Caddyfile.local.example").read_text(encoding="utf-8")
        nginx = (self.root / "deploy" / "nginx.local.example").read_text(encoding="utf-8")
        self.assertIn("respond 404", caddy)
        self.assertIn("location /", nginx)
        self.assertIn("return 404", nginx)
        self.assertNotIn("location ^~ /api/", nginx)

    def test_doctor_is_read_only_and_host_agnostic(self) -> None:
        doctor = self.root / "deploy" / "check-local-runtime.sh"
        syntax = subprocess.run(
            ["bash", "-n", str(doctor)],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        text = doctor.read_text(encoding="utf-8")
        self.assertIn("runner cannot read Gateway database", text)
        self.assertIn("public OAuth discovery", text)
        self.assertIn("remote-project helper", text)
        self.assertIn("persistent tmux backend", text)
        self.assertIn("managed current release", text)
        self.assertIn("current release manifest", text)
        self.assertNotIn("systemctl show --value", text)
        self.assertNotIn("-p User --value", text)

    def test_upgrade_script_is_valid_and_preserves_control_state(self) -> None:
        upgrade = self.root / "deploy" / "upgrade-local-runtime.sh"
        self.assertTrue(upgrade.stat().st_mode & stat.S_IXUSR)
        syntax = subprocess.run(
            ["bash", "-n", str(upgrade)],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        text = upgrade.read_text(encoding="utf-8")
        self.assertIn("APP_DIR=/opt/remote-agent", text)
        self.assertNotIn("APP_DIR=/opt/remote-agent-gateway", text)
        self.assertIn('RELEASES_DIR="$APP_DIR/releases"', text)
        self.assertIn('CURRENT_LINK="$APP_DIR/current"', text)
        self.assertIn('PREVIOUS_LINK="$APP_DIR/previous"', text)
        self.assertIn("upgrade-backups", text)
        self.assertIn("rolling back automatically", text)
        self.assertIn("Database state was preserved", text)
        self.assertNotIn("--keep", text)
        self.assertIn('[[ "$path" == "$current" || "$path" == "$previous" ]] && continue', text)
        self.assertIn("unsafe archive path", text)
        self.assertIn("Invalid release_id in manifest", text)
        self.assertIn("Refusing dirty development artifact", text)
        self.assertIn("--version VERSION", text)
        self.assertIn("--ref RELEASE_TAG", text)
        self.assertIn("REMOTE_RUNTIME_GITHUB_TOKEN_FILE", text)
        self.assertIn("/etc/remote-runtime/github-token", text)
        self.assertIn("releases/assets/$artifact_id", text)
        self.assertIn("Authorization: Bearer", text)
        self.assertIn("GitHub token file must be owned by root", text)
        self.assertIn("must not be readable or writable by group/others", text)
        self.assertNotIn("gh auth status", text)
        self.assertNotIn("GH_TOKEN", text)
        self.assertNotIn("GITHUB_TOKEN:-", text)
        self.assertIn("flock -n 9", text)
        self.assertIn(".staging-*", text)
        self.assertIn("uv pip install", text)
        health_index = text.index("if ! health_wait; then")
        self.assertGreater(text.index("/usr/local/sbin/remote-agent-upgrade"), health_index)
        self.assertGreater(text.index("/usr/local/sbin/remote-agent-doctor"), health_index)
        self.assertNotIn('rm -rf "$GATEWAY_DATA_DIR"', text)
        self.assertNotIn('rm -f "$ENV_FILE"', text)

    def test_systemd_example_matches_default_app_dir(self) -> None:
        service = (self.root / "deploy" / "remote-agent-gateway.service.example").read_text(
            encoding="utf-8"
        )
        self.assertIn("WorkingDirectory=/opt/remote-agent", service)
        self.assertIn("ExecStart=/opt/remote-agent/current/.venv/bin/python -m gateway", service)
        self.assertNotIn("/opt/remote-agent-gateway/current", service)

    def test_release_builder_declares_deterministic_inputs(self) -> None:
        builder = self.root / "tools" / "build_local_release.py"
        text = builder.read_text(encoding="utf-8")
        self.assertIn("SOURCE_DATE_EPOCH", text)
        self.assertIn("release.json", text)
        self.assertIn("SHA256SUMS.txt", text)
        self.assertIn("mtime=epoch", text)
        self.assertIn("upgrade-local-runtime.sh", text)


if __name__ == "__main__":
    unittest.main()
