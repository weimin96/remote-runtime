from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from gateway.project_cli import discover_projects, inspect_project


class ProjectCliTests(unittest.TestCase):
    def test_discovers_multiple_project_types_and_skips_nested_git_packages(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            java = root / "java-service"
            java.mkdir()
            (java / ".git").mkdir()
            (java / "pom.xml").write_text("<project/>", encoding="utf-8")
            (java / "AGENTS.md").write_text("rules", encoding="utf-8")
            nested = java / "frontend"
            nested.mkdir()
            (nested / "package.json").write_text('{"scripts":{"build":"vite build"}}', encoding="utf-8")

            node = root / "web"
            node.mkdir()
            (node / "package.json").write_text(
                json.dumps({"scripts": {"test": "vitest", "build": "vite build", "lint": "eslint ."}}),
                encoding="utf-8",
            )
            (node / "pnpm-lock.yaml").write_text("lockfileVersion: 9", encoding="utf-8")

            projects = discover_projects(root, max_depth=3)
            self.assertEqual([Path(item["path"]).name for item in projects], ["java-service", "web"])
            java_info = projects[0]
            self.assertIn("pom.xml", java_info["markers"])
            self.assertIn("AGENTS.md", java_info["rule_files"])
            web_info = projects[1]
            self.assertEqual(web_info["suggested_commands"]["test"], ["pnpm test"])
            self.assertEqual(web_info["suggested_commands"]["build"], ["pnpm run build"])

    def test_inspect_project_detects_standard_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            (root / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
            (root / "uv.lock").write_text("", encoding="utf-8")
            info = inspect_project(root)
            self.assertIn("pyproject.toml", info["markers"])
            self.assertEqual(info["suggested_commands"]["test"], ["uv run pytest"])

    def test_cli_outputs_json(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            (root / "go.mod").write_text("module example.test/demo\n", encoding="utf-8")
            result = subprocess.run(
                ["python", "-m", "gateway.project_cli", "inspect", str(root)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["path"], str(root.resolve()))
            self.assertEqual(payload["suggested_commands"]["test"], ["go test ./..."])


if __name__ == "__main__":
    unittest.main()
