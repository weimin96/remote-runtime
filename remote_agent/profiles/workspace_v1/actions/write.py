from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from remote_agent.profiles.base import ActionHandler
from remote_agent.profiles.common.filesystem import (
    WorkspaceError,
    atomic_write_bytes,
    resolve_workspace_path,
)

from ..constants import MAX_WRITE_BYTES

_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")


def validate_expected_sha256(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _SHA256_PATTERN.fullmatch(value):
        raise WorkspaceError("invalid_params", "expected_sha256 必须是 64 位十六进制字符串")
    return value.lower()


class WriteAction(ActionHandler):
    action_id = "write"

    def __init__(self, workdir: Path):
        self.workdir = workdir

    async def execute(
        self,
        request_id: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        del request_id
        path, display_path = resolve_workspace_path(self.workdir, params.get("path"))
        content = params.get("content")
        if not isinstance(content, str):
            raise WorkspaceError("invalid_params", "content 必须是字符串")
        try:
            encoded = content.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise WorkspaceError("invalid_encoding", "content 不是有效的 UTF-8 文本") from exc
        if len(encoded) > MAX_WRITE_BYTES:
            raise WorkspaceError("too_large", f"content 超过 {MAX_WRITE_BYTES} bytes 限制")
        if "expected_sha256" not in params:
            raise WorkspaceError(
                "invalid_params",
                "write 必须显式提供 expected_sha256；新建文件时传 null",
            )
        expected = validate_expected_sha256(params["expected_sha256"])
        current: bytes | None = None
        if path.exists():
            if not path.is_file():
                raise WorkspaceError("invalid_path", f"目标不是文件: {display_path}")
            if expected is None:
                raise WorkspaceError("conflict", "目标文件已存在，不能按新建模式写入")
            try:
                current = path.read_bytes()
            except PermissionError as exc:
                raise WorkspaceError("permission_denied", f"无法读取文件: {display_path}") from exc
            except OSError as exc:
                raise WorkspaceError("read_failed", f"读取文件失败: {display_path}") from exc
            if hashlib.sha256(current).hexdigest() != expected:
                raise WorkspaceError("conflict", "文件版本已变化，请重新读取后再写入")
        elif expected is not None:
            raise WorkspaceError("conflict", "目标文件不存在，无法匹配 expected_sha256")

        if current == encoded:
            digest = hashlib.sha256(encoded).hexdigest()
            return {
                "path": display_path,
                "bytes_written": len(encoded),
                "sha256": digest,
                "changed": False,
            }
        atomic_write_bytes(path, encoded)
        return {
            "path": display_path,
            "bytes_written": len(encoded),
            "sha256": hashlib.sha256(encoded).hexdigest(),
            "changed": True,
        }
