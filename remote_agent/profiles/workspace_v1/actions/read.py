from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from remote_agent.profiles.base import ActionHandler
from remote_agent.profiles.common.filesystem import (
    WorkspaceError,
    resolve_workspace_path,
    truncate_utf8,
)

from ..constants import MAX_FILE_BYTES, MAX_READ_BYTES, MAX_READ_LINES
class ReadAction(ActionHandler):
    action_id = "read"

    def __init__(self, workdir: Path):
        self.workdir = workdir

    async def execute(
        self,
        request_id: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        del request_id
        path, display_path = resolve_workspace_path(self.workdir, params.get("path"))
        offset = params.get("offset", 1)
        limit = params.get("limit", MAX_READ_LINES)
        if (
            not isinstance(offset, int)
            or isinstance(offset, bool)
            or offset < 1
            or not isinstance(limit, int)
            or isinstance(limit, bool)
            or limit < 1
        ):
            raise WorkspaceError("invalid_params", "offset 和 limit 必须是正整数")
        if limit > MAX_READ_LINES:
            raise WorkspaceError("too_large", f"limit 不能超过 {MAX_READ_LINES}")
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
        digest = hashlib.sha256(raw).hexdigest()
        has_bom = raw.startswith(b"\xef\xbb\xbf")
        try:
            text = raw[3:].decode("utf-8") if has_bom else raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WorkspaceError("invalid_encoding", "workspace.v1 只支持 UTF-8 文本") from exc

        lines = text.splitlines(keepends=True)
        if lines and offset > len(lines):
            raise WorkspaceError("invalid_params", "offset 超过文件末尾")
        start = offset - 1
        selected = lines[start : start + limit]
        content, byte_truncated = truncate_utf8("".join(selected), MAX_READ_BYTES)
        line_truncated = start > 0 or start + len(selected) < len(lines)
        return {
            "path": display_path,
            "content": content,
            "offset": offset,
            "lines": len(content.splitlines()),
            "total_lines": len(lines),
            "truncated": line_truncated or byte_truncated,
            "size": len(raw),
            "sha256": digest,
        }
