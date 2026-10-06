from __future__ import annotations

import unittest

from gateway.profiles import (
    validate_profile_agent_compatibility,
    validate_profile_declarations,
    validate_profile_result,
)


class ProfileContractTests(unittest.TestCase):
    def test_profile_minimum_agent_version_is_enforced(self) -> None:
        workspace = validate_profile_declarations(
            [
                {
                    "id": "workspace.v1",
                    "runtime": {
                        "scope": "workdir",
                        "path_format": "relative-posix",
                        "encoding": "utf-8",
                        "max_file_bytes": 8 * 1024 * 1024,
                    },
                }
            ]
        )
        with self.assertRaisesRegex(ValueError, "需要 Agent 0.2.1"):
            validate_profile_agent_compatibility(
                workspace,
                {
                    "agent_version": "0.2.0",
                    "core_version": 5,
                    "protocol_version": 2,
                    "build_id": "old-workspace",
                },
            )
        validate_profile_agent_compatibility(
            workspace,
            {
                "agent_version": "0.2.1",
                "core_version": 5,
                "protocol_version": 2,
                "build_id": "current-workspace",
            },
        )

        shell = validate_profile_declarations(
            [
                {
                    "id": "shell.v1",
                    "runtime": {
                        "os": "windows",
                        "dialect": "powershell",
                        "executable": "powershell.exe",
                    },
                }
            ]
        )
        validate_profile_agent_compatibility(
            shell,
            {
                "agent_version": "0.1.0",
                "core_version": 1,
                "protocol_version": 2,
                "build_id": "old-shell",
            },
        )

    def test_shell_declaration_requires_known_runtime_dialect(self) -> None:
        declarations = validate_profile_declarations(
            [
                {
                    "id": "shell.v1",
                    "runtime": {
                        "os": "windows",
                        "dialect": "powershell",
                        "executable": "powershell.exe",
                    },
                }
            ]
        )
        self.assertEqual(declarations[0]["runtime"]["dialect"], "powershell")

        with self.assertRaisesRegex(ValueError, "格式已升级"):
            validate_profile_declarations(["shell.v1"])
        with self.assertRaisesRegex(ValueError, "不匹配"):
            validate_profile_declarations(
                [
                    {
                        "id": "shell.v1",
                        "runtime": {
                            "os": "linux",
                            "dialect": "powershell",
                            "executable": "pwsh",
                        },
                    }
                ]
            )

    def test_shell_result_must_match_contract(self) -> None:
        result = validate_profile_result(
            "shell.v1",
            "exec",
            {"stdout": "ok", "stderr": "", "exit_code": 0},
        )
        self.assertEqual(result["exit_code"], 0)

        with self.assertRaisesRegex(ValueError, "exit_code"):
            validate_profile_result(
                "shell.v1",
                "exec",
                {"stdout": "ok", "stderr": "", "exit_code": "0"},
            )

    def test_workspace_declaration_and_results_match_contract(self) -> None:
        declarations = validate_profile_declarations(
            [
                {
                    "id": "workspace.v1",
                    "runtime": {
                        "scope": "workdir",
                        "path_format": "relative-posix",
                        "encoding": "utf-8",
                        "max_file_bytes": 8 * 1024 * 1024,
                    },
                }
            ]
        )
        self.assertEqual(declarations[0]["runtime"]["scope"], "workdir")
        result = validate_profile_result(
            "workspace.v1",
            "write",
            {
                "path": "demo.txt",
                "bytes_written": 2,
                "sha256": "a" * 64,
                "changed": True,
            },
        )
        self.assertEqual(result["bytes_written"], 2)
        with self.assertRaisesRegex(ValueError, "scope"):
            validate_profile_declarations(
                [
                    {
                        "id": "workspace.v1",
                        "runtime": {
                            "scope": "filesystem",
                            "path_format": "relative-posix",
                            "encoding": "utf-8",
                            "max_file_bytes": 8 * 1024 * 1024,
                        },
                    }
                ]
            )


if __name__ == "__main__":
    unittest.main()
