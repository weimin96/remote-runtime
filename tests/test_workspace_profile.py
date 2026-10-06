from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from remote_agent.profiles.base import ProfileContext
from remote_agent.profiles.common.filesystem import WorkspaceError
from remote_agent.profiles.workspace_v1 import WorkspaceV1Profile


class WorkspaceProfileTests(unittest.IsolatedAsyncioTestCase):
    async def test_read_write_edit_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = WorkspaceV1Profile(ProfileContext(root))
            written = await profile.execute(
                "write",
                "write-1",
                {
                    "path": "src/demo.txt",
                    "content": "one\ntwo\n",
                    "expected_sha256": None,
                },
            )
            self.assertTrue(written["changed"])
            read = await profile.execute(
                "read", "read-1", {"path": "src/demo.txt", "offset": 1, "limit": 10}
            )
            self.assertEqual(read["content"], "one\ntwo\n")
            edited = await profile.execute(
                "edit",
                "edit-1",
                {
                    "path": "src/demo.txt",
                    "old_text": "two",
                    "new_text": "three",
                    "expected_sha256": read["sha256"],
                },
            )
            self.assertTrue(edited["changed"])
            self.assertFalse(edited["diff_truncated"])
            self.assertIn("-two", edited["diff"])
            self.assertIn("+three", edited["diff"])
            final = await profile.execute("read", "read-2", {"path": "src/demo.txt"})
            self.assertEqual(final["content"], "one\nthree\n")

    async def test_edit_rejects_stale_version_and_ambiguous_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = WorkspaceV1Profile(ProfileContext(root))
            await profile.execute(
                "write",
                "write-1",
                {
                    "path": "demo.txt",
                    "content": "same\nsame\n",
                    "expected_sha256": None,
                },
            )
            current = await profile.execute("read", "read-1", {"path": "demo.txt"})
            with self.assertRaisesRegex(WorkspaceError, "conflict"):
                await profile.execute(
                    "edit",
                    "edit-stale",
                    {
                        "path": "demo.txt",
                        "old_text": "same",
                        "new_text": "new",
                        "expected_sha256": hashlib.sha256(b"old").hexdigest(),
                    },
                )
            with self.assertRaisesRegex(WorkspaceError, "ambiguous_match"):
                await profile.execute(
                    "edit",
                    "edit-ambiguous",
                    {
                        "path": "demo.txt",
                        "old_text": "same",
                        "new_text": "new",
                        "expected_sha256": current["sha256"],
                    },
                )

    async def test_write_requires_explicit_create_or_matching_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = WorkspaceV1Profile(ProfileContext(root))
            with self.assertRaisesRegex(WorkspaceError, "invalid_params"):
                await profile.execute(
                    "write", "write-missing", {"path": "demo.txt", "content": "one\n"}
                )

            created = await profile.execute(
                "write",
                "write-create",
                {"path": "demo.txt", "content": "one\n", "expected_sha256": None},
            )
            with self.assertRaisesRegex(WorkspaceError, "conflict"):
                await profile.execute(
                    "write",
                    "write-create-again",
                    {"path": "demo.txt", "content": "lost\n", "expected_sha256": None},
                )
            self.assertEqual((root / "demo.txt").read_text(encoding="utf-8"), "one\n")

            replaced = await profile.execute(
                "write",
                "write-replace",
                {
                    "path": "demo.txt",
                    "content": "two\n",
                    "expected_sha256": created["sha256"],
                },
            )
            self.assertTrue(replaced["changed"])
            with self.assertRaisesRegex(WorkspaceError, "conflict"):
                await profile.execute(
                    "write",
                    "write-stale",
                    {
                        "path": "demo.txt",
                        "content": "three\n",
                        "expected_sha256": created["sha256"],
                    },
                )
            self.assertEqual((root / "demo.txt").read_text(encoding="utf-8"), "two\n")

    async def test_read_preserves_bom_and_line_range(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "lines.txt"
            path.write_bytes(b"\xef\xbb\xbffirst\r\nsecond\r\nthird\r\n")
            profile = WorkspaceV1Profile(ProfileContext(root))
            result = await profile.execute(
                "read", "read-range", {"path": "lines.txt", "offset": 2, "limit": 1}
            )
            self.assertEqual(result["content"], "second\r\n")
            self.assertEqual(result["total_lines"], 3)
            self.assertTrue(result["truncated"])

    async def test_path_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = WorkspaceV1Profile(ProfileContext(Path(directory)))
            with self.assertRaisesRegex(WorkspaceError, "invalid_path"):
                await profile.execute("read", "escape", {"path": "../outside.txt"})


if __name__ == "__main__":
    unittest.main()
