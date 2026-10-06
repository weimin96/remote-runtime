from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


class AgentInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(__file__).resolve().parents[1]
        cls.installer = cls.root / "gateway" / "installers" / "install-agent.sh"

    def test_installer_has_valid_bash_syntax(self) -> None:
        result = subprocess.run(
            ["bash", "-n", str(self.installer)],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_upgrade_script_has_valid_bash_syntax_and_rollback(self) -> None:
        upgrade = self.root / "gateway" / "installers" / "upgrade-agent.sh"
        result = subprocess.run(
            ["bash", "-n", str(upgrade)],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        text = upgrade.read_text(encoding="utf-8")
        self.assertIn("/runtime-download", text)
        self.assertIn("/self-status", text)
        self.assertIn("--rollback", text)
        self.assertIn("rolling back", text)
        self.assertNotIn("--token-file", text)
        self.assertNotIn("enrollment_token", text)

    def test_installer_keeps_enrollment_secret_out_of_systemd(self) -> None:
        text = self.installer.read_text(encoding="utf-8")
        self.assertIn("Enrollment Token: ", text)
        self.assertIn("--token-file", text)
        self.assertIn("--enroll-only", text)
        self.assertIn("unset TOKEN", text)
        self.assertIn("Authorization: Bearer", text)
        self.assertNotIn("Environment=REMOTE_RUNTIME_TOKEN", text)
        self.assertIn('rm -f -- "$INPUT_TOKEN_FILE"', text)
        service = text.split('cat > "$SERVICE_FILE" <<SERVICE', 1)[1].split("\nSERVICE\n", 1)[0]
        self.assertNotIn("--token", service)
        self.assertNotIn("Enrollment Token", service)

    def test_installer_creates_read_only_doctor_checks(self) -> None:
        text = self.installer.read_text(encoding="utf-8")
        self.assertIn("/usr/local/sbin/remote-runtime-agent-doctor", text)
        self.assertIn("/usr/local/sbin/remote-runtime-agent-upgrade", text)
        self.assertIn("managed upgrade helper", text)
        self.assertIn("/upgrade-agent.sh", text)
        self.assertIn("device credential mode 0600", text)
        self.assertIn("systemd unit contains no enrollment token", text)
        self.assertIn("service active", text)
        self.assertIn('runuser -u "$AGENT_USER" -- test -w', text)

    def test_installer_uses_dedicated_user_and_loopback_outbound_agent_model(self) -> None:
        text = self.installer.read_text(encoding="utf-8")
        self.assertIn("AGENT_USER=remote-agent", text)
        self.assertIn("useradd --system", text)
        self.assertIn("NoNewPrivileges=true", text)
        self.assertIn("CapabilityBoundingSet=", text)
        self.assertIn("ProtectSystem=strict", text)
        self.assertIn("ProtectHome=read-only", text)
        self.assertIn("runuser -u \"$AGENT_USER\"", text)
        self.assertIn("installer will not change ownership of an existing project directory", text)

    def test_uv_python_fallback_lives_under_managed_runtime_root(self) -> None:
        text = self.installer.read_text(encoding="utf-8")
        self.assertIn('uv python install 3.12 --install-dir "$APP_DIR/.python"', text)
        self.assertIn('find "$APP_DIR/.python"', text)
        self.assertNotIn('uv venv --python 3.12', text)


if __name__ == "__main__":
    unittest.main()
