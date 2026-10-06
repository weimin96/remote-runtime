from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from unittest.mock import patch

from gateway.local_runtime import (
    MAX_ACTIVE_SESSIONS,
    MAX_COMMAND_CHARS,
    MAX_STDIN_CHARS,
    LocalCommandRuntime,
)


class LocalCommandRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.runtime = LocalCommandRuntime(self.root, max_command_timeout=5)

    async def asyncTearDown(self) -> None:
        await self.runtime.close()
        self.tempdir.cleanup()

    async def test_exec_command_returns_completed_output(self) -> None:
        result = await self.runtime.exec_command("owner-1", "printf 'hello'")

        self.assertEqual(result["output"], "hello")
        self.assertEqual(result["exit_code"], 0)
        self.assertIsNone(result["session_id"])
        self.assertFalse(result["running"])

    async def test_exec_command_returns_session_and_write_stdin_polls(self) -> None:
        result = await self.runtime.exec_command(
            "owner-1",
            "printf 'first\\n'; sleep 0.2; printf 'second\\n'",
            yield_time_ms=20,
        )

        self.assertTrue(result["running"])
        session_id = result["session_id"]
        self.assertIsInstance(session_id, str)
        await asyncio.sleep(0.25)
        completed = await self.runtime.write_stdin("owner-1", session_id, yield_time_ms=1000)

        self.assertFalse(completed["running"])
        self.assertEqual(completed["exit_code"], 0)
        self.assertIn("second", completed["output"])

    async def test_write_stdin_can_feed_running_command(self) -> None:
        result = await self.runtime.exec_command(
            "owner-1",
            "IFS= read -r line; printf 'got:%s\\n' \"$line\"",
            yield_time_ms=10,
        )
        session_id = result["session_id"]
        self.assertIsInstance(session_id, str)

        completed = await self.runtime.write_stdin(
            "owner-1",
            session_id,
            chars="value\n",
            yield_time_ms=1000,
        )

        self.assertEqual(completed["exit_code"], 0)
        self.assertEqual(completed["output"], "got:value\n")


    async def test_exec_command_uses_real_pty_by_default_on_posix(self) -> None:
        if os.name != "posix":
            self.skipTest("PTY test requires POSIX")
        result = await self.runtime.exec_command(
            "owner-1",
            "test -t 0 && test -t 1 && printf tty-ok",
        )
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["output"], "tty-ok")
        self.assertTrue(result["tty"])
        self.assertEqual(result["columns"], 120)
        self.assertEqual(result["rows"], 30)

    async def test_write_stdin_can_resize_pty(self) -> None:
        if os.name != "posix":
            self.skipTest("PTY test requires POSIX")
        result = await self.runtime.exec_command(
            "owner-1",
            "stty size; IFS= read -r line; stty size",
            yield_time_ms=20,
            columns=100,
            rows=24,
        )
        self.assertTrue(result["running"])
        self.assertIn("24 100", result["output"])
        completed = await self.runtime.write_stdin(
            "owner-1",
            str(result["session_id"]),
            chars="continue\n",
            columns=140,
            rows=40,
            yield_time_ms=1000,
        )
        self.assertEqual(completed["exit_code"], 0)
        self.assertIn("40 140", completed["output"])
        self.assertEqual(completed["columns"], 140)
        self.assertEqual(completed["rows"], 40)

    async def test_exec_command_can_disable_pty(self) -> None:
        result = await self.runtime.exec_command(
            "owner-1",
            "test -t 0; printf '%s' $?",
            tty=False,
        )
        self.assertEqual(result["output"], "1")
        self.assertFalse(result["tty"])
        self.assertIsNone(result["columns"])
        self.assertIsNone(result["rows"])

    async def test_shell_command_restores_gateway_runtime_path(self) -> None:
        result = await self.runtime.exec_command(
            "owner-1",
            "printf '%s' \"$PATH\"",
            tty=False,
        )
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["output"], self.runtime._runtime_path)

    async def test_persistent_session_requires_tmux(self) -> None:
        if self.runtime.persistent_sessions_available:
            self.skipTest("development host has tmux; covered by Linux integration smoke")
        with self.assertRaisesRegex(RuntimeError, "安装 tmux"):
            await self.runtime.exec_command(
                "owner-1",
                "sleep 1",
                yield_time_ms=0,
                persistent=True,
            )

    def test_persistent_session_id_is_bound_to_owner(self) -> None:
        tag = self.runtime._persistent_owner_tag("owner-1")
        token = "A" * 24
        session_id = f"tmux:{tag}:{token}"
        self.assertEqual(
            self.runtime._parse_persistent_session_id("owner-1", session_id),
            (tag, token),
        )
        with self.assertRaisesRegex(ValueError, "不属于当前用户"):
            self.runtime._parse_persistent_session_id("owner-2", session_id)

    async def test_persistent_session_limit_counts_only_active_sessions(self) -> None:
        self.runtime._tmux = "/usr/bin/tmux"
        owner_tag = self.runtime._persistent_owner_tag("owner-1")
        names = [
            self.runtime._persistent_tmux_name(owner_tag, "A" * 24),
            self.runtime._persistent_tmux_name(owner_tag, "B" * 24),
        ]
        self.runtime._list_persistent_session_names = AsyncMock(return_value=names)
        self.runtime._persistent_status = AsyncMock(
            side_effect=[
                (False, None, 120, 30),
                (True, 0, 120, 30),
            ]
        )
        self.runtime._kill_persistent_session = AsyncMock()

        count = await self.runtime._count_persistent_sessions(owner_tag)

        self.assertEqual(count, 1)
        self.runtime._kill_persistent_session.assert_awaited_once_with(names[1])

    async def test_persistent_result_is_snapshot_and_cleans_finished_session(self) -> None:
        self.runtime._persistent_status = AsyncMock(return_value=(True, 7, 140, 40))
        self.runtime._capture_persistent_output = AsyncMock(return_value="done")
        self.runtime._kill_persistent_session = AsyncMock()

        result = await self.runtime._persistent_result(
            "tmux:000000000000:" + "A" * 24,
            "rag_000000000000_" + "A" * 24,
            max_output_chars=100,
        )

        self.assertFalse(result["running"])
        self.assertEqual(result["exit_code"], 7)
        self.assertEqual(result["output"], "done")
        self.assertEqual(result["output_mode"], "snapshot")
        self.assertTrue(result["persistent"])
        self.runtime._kill_persistent_session.assert_awaited_once()

    async def test_cwd_cannot_escape_local_workdir(self) -> None:
        with self.assertRaisesRegex(ValueError, "白名单"):
            await self.runtime.exec_command("owner-1", "pwd", cwd="../")

    async def test_additional_workspace_root_is_allowed(self) -> None:
        other = self.root.parent / f"{self.root.name}-other"
        other.mkdir()
        runtime = LocalCommandRuntime(
            self.root,
            max_command_timeout=5,
            allowed_workdirs=(other,),
        )
        try:
            result = await runtime.exec_command(
                "owner-1",
                "pwd",
                cwd=str(other),
                tty=False,
            )
            self.assertEqual(result["exit_code"], 0)
            self.assertEqual(result["output"].strip(), str(other.resolve()))
        finally:
            await runtime.close()
            other.rmdir()

    def test_apply_patch_can_target_additional_workspace_root(self) -> None:
        other = self.root.parent / f"{self.root.name}-patch-root"
        other.mkdir()
        runtime = LocalCommandRuntime(
            self.root,
            max_command_timeout=5,
            allowed_workdirs=(other,),
        )
        try:
            result = runtime.apply_patch(
                """*** Begin Patch
*** Add File: hello.txt
+hello
*** End Patch""",
                cwd=str(other),
            )
            self.assertEqual((other / "hello.txt").read_text(), "hello\n")
            self.assertEqual(result["cwd"], str(other.resolve()))
        finally:
            (other / "hello.txt").unlink(missing_ok=True)
            other.rmdir()

    def test_additional_workspace_root_still_rejects_escape(self) -> None:
        other = self.root.parent / f"{self.root.name}-escape-root"
        other.mkdir()
        runtime = LocalCommandRuntime(
            self.root,
            max_command_timeout=5,
            allowed_workdirs=(other,),
        )
        try:
            with self.assertRaisesRegex(ValueError, "白名单"):
                runtime.resolve_cwd(str(other.parent))
        finally:
            other.rmdir()

    async def test_session_is_bound_to_owner(self) -> None:
        result = await self.runtime.exec_command(
            "owner-1",
            "sleep 2",
            yield_time_ms=10,
        )
        session_id = result["session_id"]
        self.assertIsInstance(session_id, str)
        with self.assertRaisesRegex(ValueError, "不属于当前用户"):
            await self.runtime.write_stdin("owner-2", session_id, chars="\x03")
        await self.runtime.write_stdin("owner-1", session_id, chars="\x03", yield_time_ms=1000)

    async def test_runtime_limits_command_and_stdin_size(self) -> None:
        with self.assertRaisesRegex(ValueError, "cmd 不能超过"):
            await self.runtime.exec_command("owner-1", "x" * (MAX_COMMAND_CHARS + 1))

        result = await self.runtime.exec_command("owner-1", "sleep 2", yield_time_ms=0)
        session_id = result["session_id"]
        with self.assertRaisesRegex(ValueError, "chars 不能超过"):
            await self.runtime.write_stdin(
                "owner-1",
                session_id,
                chars="x" * (MAX_STDIN_CHARS + 1),
            )
        await self.runtime.write_stdin("owner-1", session_id, chars="\x03", yield_time_ms=1000)

    async def test_runtime_limits_concurrent_commands(self) -> None:
        session_ids: list[str] = []
        for _ in range(MAX_ACTIVE_SESSIONS):
            result = await self.runtime.exec_command("owner-1", "sleep 2", yield_time_ms=0)
            session_ids.append(str(result["session_id"]))

        with self.assertRaisesRegex(RuntimeError, "运行中命令"):
            await self.runtime.exec_command("owner-1", "sleep 2", yield_time_ms=0)

        for session_id in session_ids:
            await self.runtime.write_stdin(
                "owner-1",
                session_id,
                chars="\x03",
                yield_time_ms=1000,
            )

    def test_subprocess_environment_does_not_inherit_gateway_secrets(self) -> None:
        with patch.dict(
            os.environ,
            {
                "PATH": "/usr/bin:/bin",
                "LANG": "C.UTF-8",
                "GATEWAY_DATABASE": "/secret/gateway.db",
                "API_TOKEN": "should-not-leak",
            },
            clear=True,
        ):
            env = self.runtime._subprocess_env()
        self.assertEqual(env["PATH"], "/usr/bin:/bin")
        self.assertNotIn("GATEWAY_DATABASE", env)
        self.assertNotIn("API_TOKEN", env)

    def test_exec_user_wraps_shell_with_non_interactive_sudo(self) -> None:
        with patch("gateway.local_runtime.shutil.which") as which:
            which.side_effect = lambda name: {
                "bash": "/bin/bash",
                "sh": "/bin/sh",
                "sudo": "/usr/bin/sudo",
            }.get(name)
            runtime = LocalCommandRuntime(
                self.root,
                max_command_timeout=5,
                exec_user="remote-agent-runner",
            )
        args = runtime._shell_args("id")
        self.assertEqual(
            args[:8],
            [
                "/usr/bin/sudo",
                "-n",
                "-H",
                "-u",
                "remote-agent-runner",
                "--",
                "/bin/bash",
                "-lc",
            ],
        )
        self.assertTrue(args[8].startswith("export PATH="))
        self.assertTrue(args[8].endswith("; id"))

    def test_apply_patch_add_update_move_delete(self) -> None:
        added = self.runtime.apply_patch(
            """*** Begin Patch
*** Add File: notes.txt
+alpha
+beta
*** End Patch"""
        )
        self.assertEqual((self.root / "notes.txt").read_text(), "alpha\nbeta\n")
        self.assertEqual(added["changes"][0]["action"], "add")

        updated = self.runtime.apply_patch(
            """*** Begin Patch
*** Update File: notes.txt
@@
 alpha
-beta
+gamma
*** End Patch"""
        )
        self.assertEqual((self.root / "notes.txt").read_text(), "alpha\ngamma\n")
        self.assertIn("+gamma", updated["changes"][0]["diff"])

        moved = self.runtime.apply_patch(
            """*** Begin Patch
*** Update File: notes.txt
*** Move to: archive/notes.txt
@@
-alpha
+first
 gamma
*** End Patch"""
        )
        self.assertFalse((self.root / "notes.txt").exists())
        self.assertEqual((self.root / "archive/notes.txt").read_text(), "first\ngamma\n")
        self.assertEqual(moved["changes"][0]["action"], "move")

        deleted = self.runtime.apply_patch(
            """*** Begin Patch
*** Delete File: archive/notes.txt
*** End Patch"""
        )
        self.assertFalse((self.root / "archive/notes.txt").exists())
        self.assertEqual(deleted["changes"][0]["action"], "delete")

    def test_apply_patch_rejects_parent_escape(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid_path"):
            self.runtime.apply_patch(
                """*** Begin Patch
*** Add File: ../escape.txt
+blocked
*** End Patch"""
            )


if __name__ == "__main__":
    unittest.main()
