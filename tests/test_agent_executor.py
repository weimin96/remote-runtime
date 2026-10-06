from __future__ import annotations

import asyncio
import base64
import json
import os
import shlex
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from remote_agent.core import EnvironmentAgentConfig, FatalAgentError
from remote_agent.profiles.shell_v1 import (
    MAX_CAPTURE_BYTES,
    TRUNCATION_MARKER,
    ShellExecutor,
    ShellRuntime,
    detect_shell_runtime,
)


def python_command(runtime: ShellRuntime, code: str) -> str:
    executable = str(sys.executable)
    if runtime.dialect == "powershell":
        escaped_executable = executable.replace("'", "''")
        escaped_code = code.replace("'", "''")
        return f"& '{escaped_executable}' -c '{escaped_code}'"
    if runtime.dialect == "cmd":
        return f'"{executable}" -c "{code}"'
    return f"{shlex.quote(executable)} -c {shlex.quote(code)}"


class ShellExecutorTests(unittest.IsolatedAsyncioTestCase):
    async def test_exec_closes_inherited_local_stdin(self) -> None:
        captured_options: dict[str, object] = {}

        class CompletedProcess:
            def __init__(self):
                self.returncode = 0
                self.stdout = asyncio.StreamReader()
                self.stderr = asyncio.StreamReader()
                self.stdout.feed_eof()
                self.stderr.feed_eof()

            async def wait(self) -> int:
                return self.returncode

        async def create_process(*args, **kwargs):
            del args
            captured_options.update(kwargs)
            return CompletedProcess()

        with tempfile.TemporaryDirectory() as directory:
            executor = ShellExecutor(
                Path(directory),
                ShellRuntime("linux", "posix-sh", "/bin/sh"),
            )
            with patch(
                "remote_agent.profiles.shell_v1.executor.asyncio.create_subprocess_exec",
                new=create_process,
            ):
                result = await executor.execute(
                    "request-closed-stdin",
                    {"command": "echo test", "timeout": 10},
                )

        self.assertEqual(result["exit_code"], 0)
        self.assertIs(captured_options["stdin"], asyncio.subprocess.DEVNULL)

    async def test_environment_device_secret_is_not_inherited_by_shell(self) -> None:
        variable_name = "REMOTE_AGENT_CONFIG_B64_TEST"
        config = {
            "gateway_url": "wss://gateway.example/ws/agent",
            "agent_id": "agent-ci-test",
            "credential": "agent_test_secret",
        }
        os.environ[variable_name] = base64.b64encode(
            json.dumps(config).encode("utf-8")
        ).decode("ascii")
        try:
            store = EnvironmentAgentConfig(variable_name)
            self.assertEqual(store.load(), config)
            with tempfile.TemporaryDirectory() as directory:
                executor = ShellExecutor(Path(directory))
                command = python_command(
                    executor.runtime,
                    (
                        "import os;print(os.environ.get("
                        f"'{variable_name}','not-inherited'))"
                    ),
                )
                result = await executor.execute(
                    "request-env-secret", {"command": command, "timeout": 10}
                )
        finally:
            os.environ.pop(variable_name, None)

        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["stdout"].strip(), "not-inherited")

    async def test_exec_returns_stdout_stderr_and_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executor = ShellExecutor(Path(directory))
            command = python_command(
                executor.runtime,
                "import sys;print(123);print(456,file=sys.stderr);sys.exit(7)",
            )
            result = await executor.execute("request-1", {"command": command, "timeout": 10})
        self.assertEqual(result["stdout"].strip(), "123")
        self.assertEqual(result["stderr"].strip(), "456")
        self.assertEqual(result["exit_code"], 7)

    async def test_exec_enforces_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executor = ShellExecutor(Path(directory))
            command = python_command(executor.runtime, "import time;time.sleep(10)")
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                await executor.execute("request-2", {"command": command, "timeout": 1})
            # Includes cold shell startup and process-tree cleanup on hosted Windows runners.
            self.assertLess(time.monotonic() - started, 5.0)

    async def test_exec_rejects_timeout_outside_profile_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executor = ShellExecutor(Path(directory))
            for timeout in (0, -1, 0.1, True, "1"):
                with self.subTest(timeout=timeout):
                    with self.assertRaisesRegex(ValueError, "大于等于 1 的整数"):
                        await executor.execute(
                            "request-invalid-timeout",
                            {"command": "echo test", "timeout": timeout},
                        )

    async def test_exec_caps_output_without_blocking_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executor = ShellExecutor(Path(directory))
            command = python_command(
                executor.runtime,
                f"print(chr(120)*{MAX_CAPTURE_BYTES + 1024})",
            )
            result = await executor.execute("request-3", {"command": command, "timeout": 10})
        encoded = result["stdout"].encode("utf-8")
        self.assertLessEqual(len(encoded), MAX_CAPTURE_BYTES + len(TRUNCATION_MARKER))
        self.assertIn("output truncated by remote agent", result["stdout"])

    async def test_powershell_formats_object_output_before_exit(self) -> None:
        executable = (
            shutil.which("pwsh")
            or shutil.which("powershell.exe")
            or shutil.which("powershell")
        )
        if executable is None:
            self.skipTest("PowerShell is not installed")

        runtime = ShellRuntime("windows", "powershell", executable)
        with tempfile.TemporaryDirectory() as directory:
            executor = ShellExecutor(Path(directory), runtime)
            result = await executor.execute(
                "request-object-output",
                {
                    "command": (
                        "[pscustomobject]@{ Marker = 'object-output-visible' }"
                    ),
                    "timeout": 10,
                },
            )

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("object-output-visible", result["stdout"])

    def test_windows_detection_prefers_powershell_then_cmd(self) -> None:
        executables = {
            "pwsh": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            "powershell.exe": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            "cmd.exe": "C:\\Windows\\System32\\cmd.exe",
        }

        runtime = detect_shell_runtime(
            "Windows",
            which=executables.get,
            is_file=lambda _: True,
            environment={},
        )
        self.assertEqual(runtime.dialect, "powershell")
        self.assertEqual(runtime.public_metadata()["executable"], "pwsh.exe")

        runtime = detect_shell_runtime(
            "Windows",
            which=lambda name: executables.get(name) if name in {"cmd.exe", "cmd"} else None,
            is_file=lambda _: False,
            environment={},
        )
        self.assertEqual(runtime.dialect, "cmd")

    def test_posix_detection_uses_bin_sh(self) -> None:
        runtime = detect_shell_runtime(
            "Linux",
            which=lambda _: "/unexpected/sh",
            is_file=lambda path: path == "/bin/sh",
        )
        self.assertEqual(
            runtime.public_metadata(),
            {"os": "linux", "dialect": "posix-sh", "executable": "sh"},
        )
        self.assertEqual(runtime.executable, "/bin/sh")

    def test_posix_detection_falls_back_to_sh_on_path(self) -> None:
        termux_sh = "/data/data/com.termux/files/usr/bin/sh"
        runtime = detect_shell_runtime(
            "Linux",
            which=lambda name: termux_sh if name == "sh" else None,
            is_file=lambda _: False,
        )
        self.assertEqual(runtime.operating_system, "linux")
        self.assertEqual(runtime.dialect, "posix-sh")
        self.assertEqual(runtime.executable, termux_sh)
        self.assertEqual(runtime.public_metadata()["executable"], "sh")

    def test_posix_detection_rejects_missing_sh(self) -> None:
        with self.assertRaisesRegex(FatalAgentError, "PATH 中的 sh"):
            detect_shell_runtime(
                "Linux",
                which=lambda _: None,
                is_file=lambda _: False,
            )


if __name__ == "__main__":
    unittest.main()
