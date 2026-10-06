from __future__ import annotations

import asyncio
import errno
import hashlib
import os
import re
import secrets
import shlex
import shutil
import signal
from dataclasses import dataclass, field
from pathlib import Path

from .patching import apply_codex_patch


MAX_BUFFER_BYTES = 2 * 1024 * 1024
MAX_OUTPUT_CHARS = 200_000
MAX_COMMAND_CHARS = 200_000
MAX_STDIN_CHARS = 200_000
MAX_ACTIVE_SESSIONS = 8
DEFAULT_RUNTIME_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PERSISTENT_SESSION_PREFIX = "tmux"
PERSISTENT_SESSION_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{24}$")
PERSISTENT_OWNER_TAG_RE = re.compile(r"^[0-9a-f]{12}$")


@dataclass(slots=True)
class CommandSession:
    session_id: str
    owner_user_id: str
    process: asyncio.subprocess.Process
    reader_task: asyncio.Task[None] | None = None
    watchdog_task: asyncio.Task[None] | None = None
    output: bytearray = field(default_factory=bytearray)
    output_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    truncated: bool = False
    is_pty: bool = False
    pty_master_fd: int | None = None
    columns: int = 120
    rows: int = 30


class LocalCommandRuntime:
    def __init__(
        self,
        workdir: Path,
        max_command_timeout: int,
        *,
        exec_user: str | None = None,
        allowed_workdirs: tuple[Path, ...] | None = None,
    ):
        self.workdir = workdir.expanduser().resolve()
        if not self.workdir.is_dir():
            raise RuntimeError(f"GATEWAY_LOCAL_WORKDIR 不存在或不是目录: {self.workdir}")
        roots = [self.workdir]
        roots.extend(Path(root).expanduser().resolve() for root in (allowed_workdirs or ()))
        self.allowed_workdirs = tuple(dict.fromkeys(roots))
        for root in self.allowed_workdirs:
            if not root.is_dir():
                raise RuntimeError(f"允许的工作目录不存在或不是目录: {root}")
        self.max_command_timeout = max_command_timeout
        self.exec_user = exec_user
        self._runtime_path = os.environ.get("PATH", DEFAULT_RUNTIME_PATH)
        self._sessions: dict[str, CommandSession] = {}
        self._session_lock = asyncio.Lock()
        self._closed = False
        self._shell = shutil.which("bash") or shutil.which("sh")
        if self._shell is None:
            raise RuntimeError("本机未找到 bash 或 sh，无法启用 Codex 模式")
        self._sudo = shutil.which("sudo") if exec_user else None
        self._tmux = shutil.which("tmux") if os.name == "posix" else None
        if exec_user and self._sudo is None:
            raise RuntimeError("配置了 GATEWAY_LOCAL_EXEC_USER，但系统未找到 sudo")

    async def verify_execution_identity(self) -> None:
        if self.exec_user is None:
            return
        if os.name == "nt":
            raise RuntimeError("GATEWAY_LOCAL_EXEC_USER 当前仅支持 POSIX 系统")
        import pwd

        try:
            target_uid = pwd.getpwnam(self.exec_user).pw_uid
        except KeyError as exc:
            raise RuntimeError(f"GATEWAY_LOCAL_EXEC_USER 不存在: {self.exec_user}") from exc
        if target_uid == os.geteuid():
            raise RuntimeError("GATEWAY_LOCAL_EXEC_USER 不能与 Gateway 控制面用户相同")
        assert self._sudo is not None
        process = await asyncio.create_subprocess_exec(
            self._sudo,
            "-n",
            "-H",
            "-u",
            self.exec_user,
            "--",
            "id",
            "-u",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._subprocess_env(),
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            detail = stderr.decode("utf-8", "replace").strip() or "sudo 验证失败"
            raise RuntimeError(
                "Gateway 无法以 GATEWAY_LOCAL_EXEC_USER 执行命令；"
                f"请检查 sudoers: {detail}"
            )
        try:
            actual_uid = int(stdout.decode("ascii", "strict").strip())
        except ValueError as exc:
            raise RuntimeError("无法确认本机命令执行用户 UID") from exc
        if actual_uid != target_uid:
            raise RuntimeError("sudo 返回的执行用户与 GATEWAY_LOCAL_EXEC_USER 不一致")

    async def exec_command(
        self,
        owner_user_id: str,
        cmd: str,
        *,
        cwd: str | None = None,
        yield_time_ms: int = 10_000,
        max_output_chars: int = 50_000,
        tty: bool = True,
        columns: int = 120,
        rows: int = 30,
        persistent: bool = False,
    ) -> dict[str, object]:
        if self._closed:
            raise RuntimeError("本机执行运行时已关闭")
        if not isinstance(cmd, str) or not cmd.strip():
            raise ValueError("cmd 不能为空")
        if len(cmd) > MAX_COMMAND_CHARS:
            raise ValueError(f"cmd 不能超过 {MAX_COMMAND_CHARS} 个字符")
        self._validate_yield_time(yield_time_ms)
        self._validate_output_limit(max_output_chars)
        self._validate_terminal_size(columns, rows)
        working_directory = self._resolve_cwd(cwd)
        if persistent:
            if not tty:
                raise ValueError("persistent=true 需要 tty=true")
            return await self._exec_persistent(
                owner_user_id,
                cmd,
                working_directory,
                yield_time_ms=yield_time_ms,
                max_output_chars=max_output_chars,
                columns=columns,
                rows=rows,
            )
        shell_args = self._shell_args(cmd)
        process_options: dict[str, object] = {}
        if os.name == "nt":
            process_options["creationflags"] = 0x00000200  # CREATE_NEW_PROCESS_GROUP
        else:
            process_options["start_new_session"] = True
        async with self._session_lock:
            active_sessions = sum(
                1 for session in self._sessions.values() if session.process.returncode is None
            )
            if active_sessions >= MAX_ACTIVE_SESSIONS:
                raise RuntimeError(f"当前已有 {MAX_ACTIVE_SESSIONS} 个运行中命令，请稍后重试")
            use_pty = bool(tty and os.name == "posix")
            if use_pty:
                process, master_fd = await self._spawn_pty_process(
                    shell_args, working_directory, columns=columns, rows=rows
                )
            else:
                process = await asyncio.create_subprocess_exec(
                    *shell_args,
                    cwd=working_directory,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    env=self._subprocess_env(),
                    **process_options,
                )
                master_fd = None
            session_id = secrets.token_urlsafe(18)
            session = CommandSession(
                session_id=session_id,
                owner_user_id=owner_user_id,
                process=process,
                is_pty=use_pty,
                pty_master_fd=master_fd,
                columns=columns,
                rows=rows,
            )
            session.reader_task = asyncio.create_task(self._read_output(session))
            session.watchdog_task = asyncio.create_task(self._watchdog(session))
            self._sessions[session_id] = session
        await self._wait_for_yield(session, yield_time_ms)
        return await self._result(session, max_output_chars=max_output_chars)

    async def write_stdin(
        self,
        owner_user_id: str,
        session_id: str,
        *,
        chars: str = "",
        yield_time_ms: int | None = None,
        max_output_chars: int = 50_000,
        columns: int | None = None,
        rows: int | None = None,
    ) -> dict[str, object]:
        if session_id.startswith(f"{PERSISTENT_SESSION_PREFIX}:"):
            return await self._write_persistent(
                owner_user_id,
                session_id,
                chars=chars,
                yield_time_ms=yield_time_ms,
                max_output_chars=max_output_chars,
                columns=columns,
                rows=rows,
            )
        session = self._sessions.get(session_id)
        if session is None:
            raise ValueError(f"session_id 不存在或已结束: {session_id}")
        if session.owner_user_id != owner_user_id:
            raise ValueError("session_id 不属于当前用户")
        if len(chars) > MAX_STDIN_CHARS:
            raise ValueError(f"chars 不能超过 {MAX_STDIN_CHARS} 个字符")
        self._validate_output_limit(max_output_chars)
        if columns is not None or rows is not None:
            if not session.is_pty or session.pty_master_fd is None:
                raise ValueError("当前会话不是 PTY，不能调整终端尺寸")
            new_columns = session.columns if columns is None else columns
            new_rows = session.rows if rows is None else rows
            self._validate_terminal_size(new_columns, new_rows)
            self._resize_pty(session.pty_master_fd, new_columns, new_rows)
            session.columns = new_columns
            session.rows = new_rows
        if yield_time_ms is None:
            yield_time_ms = 250 if chars else 5_000
        self._validate_yield_time(yield_time_ms)

        if chars and session.process.returncode is None:
            if chars == "\x03":
                await self._signal_interrupt(session.process)
            else:
                payload = chars.encode("utf-8")
                if session.is_pty and session.pty_master_fd is not None:
                    await asyncio.to_thread(self._write_fd_all, session.pty_master_fd, payload)
                else:
                    if session.process.stdin is None:
                        raise RuntimeError("当前会话不可写入 stdin")
                    session.process.stdin.write(payload)
                    await session.process.stdin.drain()

        await self._wait_for_yield(session, yield_time_ms)
        return await self._result(session, max_output_chars=max_output_chars)

    def apply_patch(self, patch: str, *, cwd: str | None = None) -> dict[str, object]:
        root = self.resolve_cwd(cwd)
        result = apply_codex_patch(root, patch)
        result["cwd"] = str(root)
        return result

    def resolve_cwd(self, raw_cwd: str | None) -> Path:
        return self._resolve_cwd(raw_cwd)

    @property
    def persistent_sessions_available(self) -> bool:
        return self._tmux is not None

    def _shell_args(self, cmd: str) -> list[str]:
        cmd = self._prepare_shell_command(cmd)
        shell_command = (
            [self._shell, "-lc", cmd]
            if Path(self._shell).name == "bash"
            else [self._shell, "-c", cmd]
        )
        if self.exec_user is None:
            return shell_command
        assert self._sudo is not None
        return [
            self._sudo,
            "-n",
            "-H",
            "-u",
            self.exec_user,
            "--",
            *shell_command,
        ]

    def _prepare_shell_command(self, cmd: str) -> str:
        return f"export PATH={shlex.quote(self._runtime_path)}; {cmd}"

    @staticmethod
    def _subprocess_env() -> dict[str, str]:
        env = {
            "PATH": os.environ.get("PATH", DEFAULT_RUNTIME_PATH),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "TERM": os.environ.get("TERM", "xterm-256color"),
        }
        for key in ("HOME", "USER", "LOGNAME", "LC_ALL", "LC_CTYPE", "TMPDIR"):
            value = os.environ.get(key)
            if value:
                env[key] = value
        return env


    async def _spawn_pty_process(
        self,
        shell_args: list[str],
        working_directory: Path,
        *,
        columns: int,
        rows: int,
    ) -> tuple[asyncio.subprocess.Process, int]:
        import pty
        import termios

        master_fd, slave_fd = pty.openpty()
        try:
            attrs = termios.tcgetattr(slave_fd)
            attrs[1] &= ~getattr(termios, "ONLCR", 0)
            attrs[3] &= ~termios.ECHO
            if hasattr(termios, "ECHOCTL"):
                attrs[3] &= ~termios.ECHOCTL
            termios.tcsetattr(slave_fd, termios.TCSANOW, attrs)
            self._resize_pty(slave_fd, columns, rows)
            process = await asyncio.create_subprocess_exec(
                *shell_args,
                cwd=working_directory,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                env=self._subprocess_env(),
                start_new_session=True,
            )
        except Exception:
            os.close(master_fd)
            raise
        finally:
            os.close(slave_fd)
        return process, master_fd

    async def _exec_persistent(
        self,
        owner_user_id: str,
        cmd: str,
        working_directory: Path,
        *,
        yield_time_ms: int,
        max_output_chars: int,
        columns: int,
        rows: int,
    ) -> dict[str, object]:
        if os.name != "posix" or self._tmux is None:
            raise RuntimeError(
                "persistent=true 需要目标主机安装 tmux；Gateway 不会自动安装系统软件"
            )
        owner_tag = self._persistent_owner_tag(owner_user_id)
        active_persistent = await self._count_persistent_sessions(owner_tag)
        if active_persistent >= MAX_ACTIVE_SESSIONS:
            raise RuntimeError(f"持久会话已达到上限 {MAX_ACTIVE_SESSIONS}")
        token = secrets.token_urlsafe(18)
        session_id = f"{PERSISTENT_SESSION_PREFIX}:{owner_tag}:{token}"
        tmux_name = self._persistent_tmux_name(owner_tag, token)
        shell_command = shlex.join(
            [
                self._shell,
                "-lc" if Path(self._shell).name == "bash" else "-c",
                self._prepare_shell_command(cmd),
            ]
        )
        try:
            await self._run_tmux(
                "new-session",
                "-d",
                "-s",
                tmux_name,
                "-c",
                str(working_directory),
                "-x",
                str(columns),
                "-y",
                str(rows),
            )
            await self._run_tmux("set-option", "-t", tmux_name, "remain-on-exit", "on")
            await self._run_tmux("set-option", "-t", tmux_name, "history-limit", "5000")
            await self._run_tmux(
                "respawn-pane",
                "-k",
                "-t",
                tmux_name,
                "-c",
                str(working_directory),
                shell_command,
            )
            await self._wait_persistent(tmux_name, yield_time_ms)
            return await self._persistent_result(
                session_id,
                tmux_name,
                max_output_chars=max_output_chars,
            )
        except Exception:
            await self._kill_persistent_session(tmux_name)
            raise

    async def _write_persistent(
        self,
        owner_user_id: str,
        session_id: str,
        *,
        chars: str,
        yield_time_ms: int | None,
        max_output_chars: int,
        columns: int | None,
        rows: int | None,
    ) -> dict[str, object]:
        owner_tag, token = self._parse_persistent_session_id(owner_user_id, session_id)
        if self._tmux is None:
            raise RuntimeError("目标主机未安装 tmux，无法恢复持久会话")
        if len(chars) > MAX_STDIN_CHARS:
            raise ValueError(f"chars 不能超过 {MAX_STDIN_CHARS} 个字符")
        self._validate_output_limit(max_output_chars)
        tmux_name = self._persistent_tmux_name(owner_tag, token)
        if not await self._persistent_session_exists(tmux_name):
            raise ValueError(f"persistent session 不存在或已结束: {session_id}")

        current_columns, current_rows = await self._persistent_size(tmux_name)
        new_columns = current_columns if columns is None else columns
        new_rows = current_rows if rows is None else rows
        if columns is not None or rows is not None:
            self._validate_terminal_size(new_columns, new_rows)
            await self._run_tmux(
                "resize-window",
                "-t",
                tmux_name,
                "-x",
                str(new_columns),
                "-y",
                str(new_rows),
            )

        if chars:
            dead, _, _, _ = await self._persistent_status(tmux_name)
            if not dead:
                if chars == "\x03":
                    await self._run_tmux("send-keys", "-t", tmux_name, "C-c")
                else:
                    buffer_name = f"rag_{token}"
                    await self._run_tmux(
                        "load-buffer",
                        "-b",
                        buffer_name,
                        "-",
                        stdin=chars.encode("utf-8"),
                    )
                    await self._run_tmux(
                        "paste-buffer",
                        "-d",
                        "-b",
                        buffer_name,
                        "-t",
                        tmux_name,
                    )

        if yield_time_ms is None:
            yield_time_ms = 250 if chars else 5_000
        self._validate_yield_time(yield_time_ms)
        await self._wait_persistent(tmux_name, yield_time_ms)
        return await self._persistent_result(
            session_id,
            tmux_name,
            max_output_chars=max_output_chars,
        )

    async def _persistent_result(
        self,
        session_id: str,
        tmux_name: str,
        *,
        max_output_chars: int,
    ) -> dict[str, object]:
        dead, exit_code, columns, rows = await self._persistent_status(tmux_name)
        output = await self._capture_persistent_output(tmux_name)
        truncated = False
        if len(output) > max_output_chars:
            output = output[-max_output_chars:]
            truncated = True
        result: dict[str, object] = {
            "output": output,
            "exit_code": exit_code if dead else None,
            "session_id": None if dead else session_id,
            "running": not dead,
            "truncated": truncated,
            "tty": True,
            "columns": columns,
            "rows": rows,
            "persistent": True,
            "output_mode": "snapshot",
        }
        if dead:
            await self._kill_persistent_session(tmux_name)
        return result

    async def _persistent_status(self, tmux_name: str) -> tuple[bool, int | None, int, int]:
        output = await self._run_tmux(
            "display-message",
            "-p",
            "-t",
            tmux_name,
            "#{pane_dead}|#{pane_dead_status}|#{pane_width}|#{pane_height}",
        )
        parts = output.strip().split("|")
        if len(parts) != 4:
            raise RuntimeError("无法解析 tmux 会话状态")
        dead = parts[0] == "1"
        exit_code = int(parts[1]) if dead and parts[1].lstrip("-").isdigit() else None
        try:
            columns = int(parts[2])
            rows = int(parts[3])
        except ValueError as exc:
            raise RuntimeError("无法解析 tmux 终端尺寸") from exc
        return dead, exit_code, columns, rows

    async def _persistent_size(self, tmux_name: str) -> tuple[int, int]:
        _, _, columns, rows = await self._persistent_status(tmux_name)
        return columns, rows

    async def _capture_persistent_output(self, tmux_name: str) -> str:
        output = await self._run_tmux(
            "capture-pane",
            "-p",
            "-J",
            "-t",
            tmux_name,
            "-S",
            "-2000",
        )
        return output.rstrip("\n")

    async def _wait_persistent(self, tmux_name: str, yield_time_ms: int) -> None:
        if yield_time_ms <= 0:
            return
        deadline = asyncio.get_running_loop().time() + (yield_time_ms / 1000)
        while True:
            dead, _, _, _ = await self._persistent_status(tmux_name)
            if dead:
                return
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return
            await asyncio.sleep(min(0.1, remaining))

    async def _persistent_session_exists(self, tmux_name: str) -> bool:
        if self._tmux is None:
            return False
        process = await self._create_tmux_process("has-session", "-t", tmux_name)
        await process.communicate()
        return process.returncode == 0

    async def _count_persistent_sessions(self, owner_tag: str) -> int:
        names = await self._list_persistent_session_names(owner_tag)
        active = 0
        for name in names:
            try:
                dead, _, _, _ = await self._persistent_status(name)
            except RuntimeError:
                continue
            if dead:
                await self._kill_persistent_session(name)
            else:
                active += 1
        return active

    async def _list_persistent_session_names(self, owner_tag: str) -> list[str]:
        if self._tmux is None:
            return []
        process = await self._create_tmux_process(
            "list-sessions",
            "-F",
            "#{session_name}",
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            detail = stderr.decode("utf-8", "replace").lower()
            if (
                "no server" in detail
                or "failed to connect" in detail
                or "no sessions" in detail
            ):
                return []
            raise RuntimeError(stderr.decode("utf-8", "replace").strip() or "tmux list-sessions failed")
        prefix = f"rag_{owner_tag}_"
        return [
            line.strip()
            for line in stdout.decode("utf-8", "replace").splitlines()
            if line.strip().startswith(prefix)
        ]

    async def _kill_persistent_session(self, tmux_name: str) -> None:
        if self._tmux is None:
            return
        process = await self._create_tmux_process("kill-session", "-t", tmux_name)
        await process.communicate()

    async def _run_tmux(self, *args: str, stdin: bytes | None = None) -> str:
        process = await self._create_tmux_process(*args, stdin_pipe=stdin is not None)
        stdout, stderr = await process.communicate(stdin)
        if process.returncode != 0:
            detail = stderr.decode("utf-8", "replace").strip() or "tmux command failed"
            raise RuntimeError(detail)
        return stdout.decode("utf-8", "replace")

    async def _create_tmux_process(
        self,
        *args: str,
        stdin_pipe: bool = False,
    ) -> asyncio.subprocess.Process:
        if self._tmux is None:
            raise RuntimeError("tmux 未安装")
        command = [self._tmux, *args]
        if self.exec_user is not None:
            assert self._sudo is not None
            command = [
                self._sudo,
                "-n",
                "-H",
                "-u",
                self.exec_user,
                "--",
                *command,
            ]
        return await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE if stdin_pipe else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._subprocess_env(),
        )

    @staticmethod
    def _persistent_owner_tag(owner_user_id: str) -> str:
        return hashlib.sha256(owner_user_id.encode("utf-8")).hexdigest()[:12]

    def _parse_persistent_session_id(
        self,
        owner_user_id: str,
        session_id: str,
    ) -> tuple[str, str]:
        parts = session_id.split(":")
        if len(parts) != 3 or parts[0] != PERSISTENT_SESSION_PREFIX:
            raise ValueError("persistent session_id 格式无效")
        owner_tag, token = parts[1], parts[2]
        if not PERSISTENT_OWNER_TAG_RE.fullmatch(owner_tag) or not PERSISTENT_SESSION_TOKEN_RE.fullmatch(token):
            raise ValueError("persistent session_id 格式无效")
        if owner_tag != self._persistent_owner_tag(owner_user_id):
            raise ValueError("session_id 不属于当前用户")
        return owner_tag, token

    @staticmethod
    def _persistent_tmux_name(owner_tag: str, token: str) -> str:
        return f"rag_{owner_tag}_{token}"

    @staticmethod
    def _resize_pty(fd: int, columns: int, rows: int) -> None:
        import fcntl
        import struct
        import termios

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    @staticmethod
    def _write_fd_all(fd: int, payload: bytes) -> None:
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            view = view[written:]

    async def close(self) -> None:
        self._closed = True
        sessions = list(self._sessions.values())
        for session in sessions:
            if session.process.returncode is None:
                await self._terminate(session.process)
        for session in sessions:
            if session.reader_task is not None:
                await asyncio.gather(session.reader_task, return_exceptions=True)
            if session.watchdog_task is not None:
                session.watchdog_task.cancel()
                await asyncio.gather(session.watchdog_task, return_exceptions=True)
        self._sessions.clear()

    async def _read_output(self, session: CommandSession) -> None:
        if session.is_pty and session.pty_master_fd is not None:
            await self._read_pty_output(session)
            return
        stream = session.process.stdout
        if stream is None:
            return
        while True:
            chunk = await stream.read(64 * 1024)
            if not chunk:
                return
            await self._append_output(session, chunk)

    async def _read_pty_output(self, session: CommandSession) -> None:
        master_fd = session.pty_master_fd
        if master_fd is None:
            return
        try:
            while True:
                try:
                    chunk = await asyncio.to_thread(os.read, master_fd, 64 * 1024)
                except OSError as exc:
                    if exc.errno in {errno.EIO, errno.EBADF}:
                        return
                    raise
                if not chunk:
                    return
                await self._append_output(session, chunk)
        finally:
            try:
                os.close(master_fd)
            except OSError:
                pass
            session.pty_master_fd = None

    @staticmethod
    async def _append_output(session: CommandSession, chunk: bytes) -> None:
        async with session.output_lock:
            session.output.extend(chunk)
            overflow = len(session.output) - MAX_BUFFER_BYTES
            if overflow > 0:
                del session.output[:overflow]
                session.truncated = True

    async def _watchdog(self, session: CommandSession) -> None:
        try:
            await asyncio.sleep(self.max_command_timeout)
        except asyncio.CancelledError:
            return
        if session.process.returncode is None:
            await self._terminate(session.process)

    async def _wait_for_yield(self, session: CommandSession, yield_time_ms: int) -> None:
        if session.process.returncode is not None or yield_time_ms == 0:
            return
        try:
            await asyncio.wait_for(
                asyncio.shield(session.process.wait()),
                timeout=yield_time_ms / 1000,
            )
        except asyncio.TimeoutError:
            return
        if session.process.returncode is not None:
            if session.reader_task is not None:
                await session.reader_task

    async def _result(
        self,
        session: CommandSession,
        *,
        max_output_chars: int,
    ) -> dict[str, object]:
        if session.process.returncode is not None and session.reader_task is not None:
            await session.reader_task
        async with session.output_lock:
            raw = bytes(session.output)
            session.output.clear()
            truncated = session.truncated
            session.truncated = False
        output = raw.decode("utf-8", "replace")
        if len(output) > max_output_chars:
            output = output[:max_output_chars]
            truncated = True

        running = session.process.returncode is None
        result: dict[str, object] = {
            "output": output,
            "exit_code": None if running else session.process.returncode,
            "session_id": session.session_id if running else None,
            "running": running,
            "truncated": truncated,
            "tty": session.is_pty,
            "columns": session.columns if session.is_pty else None,
            "rows": session.rows if session.is_pty else None,
        }
        if not running:
            if session.watchdog_task is not None:
                session.watchdog_task.cancel()
                await asyncio.gather(session.watchdog_task, return_exceptions=True)
            self._sessions.pop(session.session_id, None)
        return result

    def _resolve_cwd(self, raw_cwd: str | None) -> Path:
        if raw_cwd is None or not raw_cwd.strip():
            return self.workdir
        candidate = Path(raw_cwd).expanduser()
        if not candidate.is_absolute():
            candidate = self.workdir / candidate
        candidate = candidate.resolve()
        if not any(self._is_within(candidate, root) for root in self.allowed_workdirs):
            raise ValueError("cwd 不在允许的工作目录白名单内")
        if not candidate.is_dir():
            raise ValueError(f"cwd 不存在或不是目录: {raw_cwd}")
        return candidate

    @staticmethod
    def _is_within(candidate: Path, root: Path) -> bool:
        try:
            candidate.relative_to(root)
            return True
        except ValueError:
            return False


    @staticmethod
    def _validate_terminal_size(columns: int, rows: int) -> None:
        if (
            isinstance(columns, bool)
            or not isinstance(columns, int)
            or columns < 20
            or columns > 500
        ):
            raise ValueError("columns 必须在 20 到 500 之间")
        if isinstance(rows, bool) or not isinstance(rows, int) or rows < 5 or rows > 200:
            raise ValueError("rows 必须在 5 到 200 之间")

    @staticmethod
    def _validate_yield_time(value: int) -> None:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 30_000:
            raise ValueError("yield_time_ms 必须在 0 到 30000 之间")

    @staticmethod
    def _validate_output_limit(value: int) -> None:
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 1
            or value > MAX_OUTPUT_CHARS
        ):
            raise ValueError(f"max_output_chars 必须在 1 到 {MAX_OUTPUT_CHARS} 之间")

    @staticmethod
    async def _signal_interrupt(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        if os.name == "nt":
            process.send_signal(signal.CTRL_BREAK_EVENT)
            return
        try:
            os.killpg(process.pid, signal.SIGINT)
        except ProcessLookupError:
            pass

    @staticmethod
    async def _terminate(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        if os.name == "nt":
            process.kill()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.returncode is None:
            process.kill()
        await process.wait()
