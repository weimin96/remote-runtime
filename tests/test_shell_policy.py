from __future__ import annotations

import unittest

from gateway.shell_policy import describe_shell_policy, evaluate_shell_command


POWERSHELL = {"os": "windows", "dialect": "powershell", "executable": "powershell.exe"}
CMD = {"os": "windows", "dialect": "cmd", "executable": "cmd.exe"}
POSIX = {"os": "linux", "dialect": "posix-sh", "executable": "sh"}


class ShellPolicyTests(unittest.TestCase):
    def test_off_preserves_existing_shell_behavior(self) -> None:
        self.assertIsNone(
            evaluate_shell_command(
                mode="off", runtime=POWERSHELL, command="Format-Volume -DriveLetter C"
            )
        )

    def test_standard_blocks_each_system_rule(self) -> None:
        cases = [
            (POWERSHELL, "Format-Volume -DriveLetter C", "disk_management"),
            (CMD, "shutdown /r /t 0", "system_power"),
            (POSIX, "sudo whoami", "privilege_escalation"),
            (POSIX, "cat ~/.ssh/id_ed25519", "credential_store_access"),
            (POWERSHELL, "Register-ScheduledTask -TaskName demo", "persistence"),
            (POWERSHELL, "Set-MpPreference -DisableRealtimeMonitoring $true", "security_controls"),
        ]
        for runtime, command, rule_id in cases:
            with self.subTest(command=command):
                violation = evaluate_shell_command(
                    mode="standard", runtime=runtime, command=command
                )
                self.assertIsNotNone(violation)
                self.assertEqual(violation.rule_id, rule_id)

    def test_standard_does_not_block_normal_development_file_operations(self) -> None:
        commands = [
            (POSIX, "rm -rf ./build"),
            (POWERSHELL, "Remove-Item -Recurse -Force .\\build"),
            (CMD, "del /q build\\artifact.txt"),
            (POSIX, "git clean -fd"),
        ]
        for runtime, command in commands:
            with self.subTest(command=command):
                self.assertIsNone(
                    evaluate_shell_command(mode="standard", runtime=runtime, command=command)
                )

    def test_standard_fails_closed_when_runtime_is_unavailable(self) -> None:
        violation = evaluate_shell_command(mode="standard", runtime=None, command="pwd")
        self.assertIsNotNone(violation)
        self.assertEqual(violation.rule_id, "policy_unavailable")

    def test_policy_description_exposes_only_two_modes(self) -> None:
        policy = describe_shell_policy("off")
        self.assertEqual(policy["mode"], "off")
        self.assertEqual([item["id"] for item in policy["modes"]], ["off", "standard"])
        self.assertEqual(len(policy["rules"]), 6)


if __name__ == "__main__":
    unittest.main()
