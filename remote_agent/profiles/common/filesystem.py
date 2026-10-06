from __future__ import annotations

import hashlib
import os
import secrets
import stat
from pathlib import Path, PurePosixPath, PureWindowsPath


class WorkspaceError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


def truncate_utf8(value: str, maximum: int) -> tuple[str, bool]:
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum:
        return value, False
    truncated = encoded[:maximum]
    while truncated:
        try:
            return truncated.decode("utf-8"), True
        except UnicodeDecodeError:
            truncated = truncated[:-1]
    return "", True


def resolve_workspace_path(root: Path, raw_path: object) -> tuple[Path, str]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise WorkspaceError("invalid_path", "path 必须是非空字符串")
    normalized = raw_path.strip().replace("\\", "/")
    posix = PurePosixPath(normalized)
    windows = PureWindowsPath(normalized)
    if posix.is_absolute() or windows.is_absolute() or windows.drive:
        raise WorkspaceError("invalid_path", "path 必须是工作目录下的相对路径")
    if ".." in posix.parts:
        raise WorkspaceError("invalid_path", "path 不能包含 ..")
    if not posix.parts:
        raise WorkspaceError("invalid_path", "path 不能为空")

    root_path = root.expanduser().resolve()
    candidate = (root_path.joinpath(*posix.parts)).resolve(strict=False)
    try:
        candidate.relative_to(root_path)
    except ValueError as exc:
        raise WorkspaceError("invalid_path", "path 不能逃出工作目录") from exc
    return candidate, "/".join(posix.parts)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except FileNotFoundError as exc:
        raise WorkspaceError("not_found", f"文件不存在: {path.name}") from exc
    except PermissionError as exc:
        raise WorkspaceError("permission_denied", f"无法读取文件: {path.name}") from exc
    return digest.hexdigest()


def atomic_write_bytes(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.remote-agent-{secrets.token_hex(8)}.tmp")
    existing_mode: int | None = None
    try:
        if path.exists():
            existing_mode = stat.S_IMODE(path.stat().st_mode)
        path.parent.mkdir(parents=True, exist_ok=True)
        with temporary.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if existing_mode is not None:
            os.chmod(temporary, existing_mode)
        os.replace(temporary, path)
    except PermissionError as exc:
        raise WorkspaceError("permission_denied", f"无法写入文件: {path.name}") from exc
    except OSError as exc:
        raise WorkspaceError("write_failed", f"写入文件失败: {path.name}") from exc
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
