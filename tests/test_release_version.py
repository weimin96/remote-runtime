from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


class ReleaseVersionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(__file__).resolve().parents[1]

    def test_all_release_version_sources_match(self) -> None:
        result = subprocess.run(
            ["python3", "tools/check_release_version.py"],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout.strip(), r"^\d+\.\d+\.\d+$")

    def test_expected_tag_is_accepted(self) -> None:
        version = subprocess.check_output(
            ["python3", "tools/check_release_version.py"],
            cwd=self.root,
            text=True,
        ).strip()
        result = subprocess.run(
            ["python3", "tools/check_release_version.py", f"v{version}"],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
