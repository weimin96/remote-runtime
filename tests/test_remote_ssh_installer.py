from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


class RemoteSshInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(__file__).resolve().parents[1]
        cls.installer = cls.root / "install-remote-ssh.sh"

    def test_installer_has_valid_bash_syntax(self) -> None:
        result = subprocess.run(
            ["bash", "-n", str(self.installer)],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_installer_uses_prebuilt_release_artifacts(self) -> None:
        text = self.installer.read_text(encoding="utf-8")
        self.assertIn("api.github.com/repos/$REPOSITORY/releases", text)
        self.assertIn("remote-ssh-v${version}-", text)
        self.assertIn("application/octet-stream", text)
        self.assertIn("artifact.url", text)
        self.assertIn("checksum mismatch", text)
        self.assertIn("codex plugin marketplace list --json", text)
        self.assertIn("codex plugin marketplace remove remote-agent --json", text)
        self.assertIn('codex plugin marketplace add "$INSTALL_DIR" --json', text)
        self.assertIn("codex plugin add remote-ssh@remote-agent --json", text)
        self.assertNotIn("git clone", text)
        self.assertNotIn("command -v npm", text)
        self.assertNotIn("npm --prefix", text)


if __name__ == "__main__":
    unittest.main()
