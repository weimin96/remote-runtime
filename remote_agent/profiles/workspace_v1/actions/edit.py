from __future__ import annotations

import difflib
import hashlib
from pathlib import Path
from typing import Any

from remote_agent.profiles.base import ActionHandler
from remote_agent.profiles.common.filesystem import (
    WorkspaceError,
    atomic_write_bytes,
    resolve_workspace_path,
    truncate_utf8,
)

from .write import validate_expected_sha256
from ..constants import MAX_FILE_BYTES, MAX_READ_BYTES, MAX_WRITE_BYTES


def _normalize_newlines(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _first_changed_line(old: str, new: str) -> int | None:
    matcher = difflib.SequenceMatcher(a=old.splitlines(), b=new.splitlines())
    for tag, old_start, old_end, _, _ in matcher.get_opcodes():
        if tag != "equal":
            return old_start + 1
    return None


class EditAction(ActionHandler):
    action_id = "edit"

    def __init__(self, workdir: Path):
        self.workdir = workdir

    async def execute(
        self,
        request_id: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        del request_id
        path, display_path = resolve_workspace_path(self.workdir, params.get("path"))
        old_text = params.get("old_text")
        new_text = params.get("new_text")
        expected = validate_expected_sha256(params.get("expected_sha256"))
        if not isinstance(old_text, str) or not isinstance(new_text, str):
            raise WorkspaceError("invalid_params", "old_text 和 new_text 必须是字符串")
        if not old_text:
            raise WorkspaceError("invalid_params", "old_text 不能为空")
        if old_text == new_text:
            raise WorkspaceError("invalid_params", "old_text 和 new_text 必须不同")
        if expected is None:
            raise WorkspaceError("invalid_params", "edit 必须提供 expected_sha256")
        if not path.exists():
            raise WorkspaceError("not_found", f"文件不存在: {display_path}")
        if not path.is_file():
            raise WorkspaceError("invalid_path", f"目标不是文件: {display_path}")
        try:
            raw = path.read_bytes()
        except FileNotFoundError as exc:
            raise WorkspaceError("not_found", f"文件不存在: {display_path}") from exc
        except PermissionError as exc:
            raise WorkspaceError("permission_denied", f"无法读取文件: {display_path}") from exc
        except OSError as exc:
            raise WorkspaceError("read_failed", f"读取文件失败: {display_path}") from exc
        if len(raw) > MAX_FILE_BYTES:
            raise WorkspaceError("too_large", f"文件超过 {MAX_FILE_BYTES} bytes 限制")
        actual = hashlib.sha256(raw).hexdigest()
        if actual != expected:
            raise WorkspaceError("conflict", "文件版本已变化，请重新读取后再编辑")

        has_bom = raw.startswith(b"\xef\xbb\xbf")
        try:
            text = raw[3:].decode("utf-8") if has_bom else raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WorkspaceError("invalid_encoding", "workspace.v1 只支持 UTF-8 文本") from exc
        normalized = _normalize_newlines(text)
        old_normalized = _normalize_newlines(old_text)
        new_normalized = _normalize_newlines(new_text)
        if old_normalized == new_normalized:
            raise WorkspaceError("invalid_params", "归一化后 old_text 和 new_text 必须不同")
        matches = normalized.count(old_normalized)
        if matches == 0:
            raise WorkspaceError("not_found", "old_text 未匹配到文件内容")
        if matches > 1:
            raise WorkspaceError("ambiguous_match", "old_text 匹配了多处内容，拒绝修改")

        updated = normalized.replace(old_normalized, new_normalized, 1)
        newline = "\r\n" if "\r\n" in text else "\n"
        output_text = updated.replace("\n", newline)
        output = (b"\xef\xbb\xbf" if has_bom else b"") + output_text.encode("utf-8")
        if len(output) > MAX_WRITE_BYTES:
            raise WorkspaceError("too_large", f"修改后文件超过 {MAX_WRITE_BYTES} bytes 限制")
        diff = "".join(
            difflib.unified_diff(
                normalized.splitlines(keepends=True),
                updated.splitlines(keepends=True),
                fromfile=f"a/{display_path}",
                tofile=f"b/{display_path}",
            )
        )
        diff, diff_truncated = truncate_utf8(diff, MAX_READ_BYTES)
        first_changed_line = _first_changed_line(normalized, updated)
        if first_changed_line is None:
            raise WorkspaceError("invalid_params", "编辑没有产生有效变化")
        atomic_write_bytes(path, output)
        return {
            "path": display_path,
            "changed": True,
            "diff": diff,
            "diff_truncated": diff_truncated,
            "first_changed_line": first_changed_line,
            "sha256": hashlib.sha256(output).hexdigest(),
        }
