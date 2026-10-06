from __future__ import annotations

import asyncio
import base64
import locale
import os
import platform
import signal
import shutil
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from remote_agent.core.errors import FatalAgentError

MAX_CAPTURE_BYTES = 2 * 1024 * 1024
TRUNCATION_MARKER = b"\n[output truncated by remote agent]\n"


@dataclass(frozen=True, slots=True)
class ShellRuntime:
    operating_system: str
    dialect: str
    executable: str

    def public_metadata(self) -> dict[str, str]:
        if self.operating_system == "windows":
            executable_name = PureWindowsPath(self.executable).name
        else:
            executable_name = PurePosixPath(self.executable).name
        return {
            "os": self.operating_system,
            "dialect": self.dialect,
            "executable": executable_name,
        }

    def command_argv(self, command: str) -> list[str]:
        if self.dialect == "powershell":
            # PowerShell defers formatting rich objects until its default output
            # pipeline runs. Force that pipeline to finish before the explicit
            # exit below, otherwise cmdlets such as Get-Item can succeed while
            # their object output never reaches stdout.
            script = (
                "$OutputEncoding = [Console]::OutputEncoding = "
                "[System.Text.UTF8Encoding]::new($false)\n"
                "$global:LASTEXITCODE = $null\n"
                "$script:__remoteAgentShellSuccess = $false\n"
                "$script:__remoteAgentNativeExitCode = $null\n"
                "& {\n"
                f"{command}\n"
                "  $script:__remoteAgentShellSuccess = $?\n"
                "  $script:__remoteAgentNativeExitCode = $LASTEXITCODE\n"
                "} | Out-Default\n"
                "if (-not $script:__remoteAgentShellSuccess) {\n"
                "  if ($null -ne $script:__remoteAgentNativeExitCode -and "
                "$script:__remoteAgentNativeExitCode -ne 0) { "
                "exit $script:__remoteAgentNativeExitCode }\n"
                "  exit 1\n"
                "}\n"
                "exit 0\n"
            )
            encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
            return [
                self.executable,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                encoded,
            ]
        if self.dialect == "cmd":
            return [self.executable, "/D", "/C", command]
        return [self.executable, "-c", command]

    @property
    def output_encoding(self) -> str:
        if self.dialect == "powershell":
            return "utf-8"
        return locale.getpreferredencoding(False) or "utf-8"


def detect_shell_runtime(
    system_name: str | None = None,
    *,
    which: Callable[[str], str | None] = shutil.which,
    is_file: Callable[[str], bool] = os.path.isfile,
    environment: Mapping[str, str] | None = None,
) -> ShellRuntime:
    system = (system_name or platform.system()).strip().lower()
    if environment is None:
        environment = os.environ
    if system == "windows":
        pwsh = which("pwsh")
        if pwsh:
            return ShellRuntime("windows", "powershell", pwsh)
        powershell = which("powershell.exe") or which("powershell")
        if powershell:
            return ShellRuntime("windows", "powershell", powershell)
        comspec = environment.get("COMSPEC")
        if comspec and is_file(comspec):
            return ShellRuntime("windows", "cmd", comspec)
        command_prompt = which("cmd.exe") or which("cmd")
        if command_prompt:
            return ShellRuntime("windows", "cmd", command_prompt)
        raise FatalAgentError("当前 Windows 环境未找到 pwsh、powershell.exe 或 cmd.exe")

    operating_system = {"darwin": "macos", "linux": "linux"}.get(system, "posix")
    executable = "/bin/sh" if is_file("/bin/sh") else which("sh")
    if not executable:
        raise FatalAgentError("当前系统未找到 /bin/sh 或 PATH 中的 sh，无法启用 shell.v1")
    return ShellRuntime(operating_system, "posix-sh", executable)


class ShellExecutor:
    def __init__(self, workdir: Path, runtime: ShellRuntime | None = None):
        self.workdir = workdir
        self.runtime = runtime or detect_shell_runtime()
        self.processes: dict[str, asyncio.subprocess.Process] = {}

    async def execute(self, request_id: str, params: dict[str, Any]) -> dict[str, Any]:
        command = params.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ValueError("command 不能为空")
        timeout = params.get("timeout", 300)
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 1:
            raise ValueError("timeout 必须是大于等于 1 的整数")

        process_options: dict[str, Any] = {}
        if os.name == "nt":
            process_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            process_options["start_new_session"] = True
        process = await asyncio.create_subprocess_exec(
            *self.runtime.command_argv(command),
            cwd=self.workdir,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **process_options,
        )
        self.processes[request_id] = process
        stdout_task = asyncio.create_task(self._capture_stream(process.stdout))
        stderr_task = asyncio.create_task(self._capture_stream(process.stderr))
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            await self._terminate(process)
            await process.wait()
            await asyncio.gather(stdout_task, stderr_task)
            raise TimeoutError(f"命令执行超时 ({timeout:g}s)")
        except asyncio.CancelledError:
            if process.returncode is None:
                await self._terminate(process)
                await process.wait()
            await asyncio.gather(stdout_task, stderr_task)
            raise
        finally:
            self.processes.pop(request_id, None)

        stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
        return {
            "stdout": stdout.decode(self.runtime.output_encoding, "replace"),
            "stderr": stderr.decode(self.runtime.output_encoding, "replace"),
            "exit_code": process.returncode,
        }

    @staticmethod
    async def _capture_stream(stream: asyncio.StreamReader | None) -> bytes:
        if stream is None:
            return b""
        captured = bytearray()
        truncated = False
        while True:
            chunk = await stream.read(64 * 1024)
            if not chunk:
                break
            remaining = MAX_CAPTURE_BYTES - len(captured)
            if remaining > 0:
                captured.extend(chunk[:remaining])
            if len(chunk) > remaining:
                truncated = True
        if truncated:
            captured.extend(TRUNCATION_MARKER)
        return bytes(captured)

    async def cancel(self, request_id: str) -> None:
        process = self.processes.get(request_id)
        if process is not None and process.returncode is None:
            await self._terminate(process)

    @staticmethod
    async def _terminate(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        if os.name == "nt":
            killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/PID",
                str(process.pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.returncode is None:
            process.kill()
