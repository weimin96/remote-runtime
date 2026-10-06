from __future__ import annotations

import difflib
from dataclasses import dataclass
from pathlib import Path

from remote_agent.profiles.common.filesystem import atomic_write_bytes, resolve_workspace_path


MAX_PATCH_BYTES = 2 * 1024 * 1024
MAX_PATCH_FILE_BYTES = 8 * 1024 * 1024


class PatchError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class PatchOperation:
    action: str
    path: str
    lines: tuple[str, ...]
    move_to: str | None = None


def apply_codex_patch(root: Path, patch: str) -> dict[str, object]:
    if not isinstance(patch, str) or not patch.strip():
        raise PatchError("patch 不能为空")
    if len(patch.encode("utf-8")) > MAX_PATCH_BYTES:
        raise PatchError("patch 超过 2 MiB 限制")
    operations = _parse_patch(patch)
    changes: list[dict[str, object]] = []
    for operation in operations:
        if operation.action == "add":
            changes.append(_apply_add(root, operation))
        elif operation.action == "delete":
            changes.append(_apply_delete(root, operation))
        else:
            changes.append(_apply_update(root, operation))
    return {"changes": changes}


def _parse_patch(patch: str) -> list[PatchOperation]:
    normalized = patch.replace("\r\n", "\n")
    lines = normalized.split("\n")
    if not lines or lines[0] != "*** Begin Patch":
        raise PatchError("patch 必须以 *** Begin Patch 开始")
    try:
        end_index = lines.index("*** End Patch", 1)
    except ValueError as exc:
        raise PatchError("patch 缺少 *** End Patch") from exc
    if any(line for line in lines[end_index + 1 :]):
        raise PatchError("*** End Patch 后不能包含其他内容")

    operations: list[PatchOperation] = []
    index = 1
    while index < end_index:
        header = lines[index]
        if header.startswith("*** Add File: "):
            action = "add"
            path = header.removeprefix("*** Add File: ").strip()
        elif header.startswith("*** Delete File: "):
            action = "delete"
            path = header.removeprefix("*** Delete File: ").strip()
        elif header.startswith("*** Update File: "):
            action = "update"
            path = header.removeprefix("*** Update File: ").strip()
        else:
            raise PatchError(f"无效 patch 操作头: {header}")
        if not path:
            raise PatchError("patch 文件路径不能为空")
        index += 1
        body: list[str] = []
        move_to: str | None = None
        if action == "update" and index < end_index and lines[index].startswith("*** Move to: "):
            move_to = lines[index].removeprefix("*** Move to: ").strip()
            if not move_to:
                raise PatchError("Move to 路径不能为空")
            index += 1
        while index < end_index and not lines[index].startswith(
            ("*** Add File: ", "*** Delete File: ", "*** Update File: ")
        ):
            body.append(lines[index])
            index += 1
        operations.append(PatchOperation(action, path, tuple(body), move_to))
    if not operations:
        raise PatchError("patch 中没有文件操作")
    return operations


def _apply_add(root: Path, operation: PatchOperation) -> dict[str, object]:
    path, normalized = resolve_workspace_path(root, operation.path)
    if path.exists():
        raise PatchError(f"目标文件已存在: {normalized}")
    content_lines: list[str] = []
    for line in operation.lines:
        if not line.startswith("+"):
            raise PatchError(f"Add File 内容必须以 + 开头: {normalized}")
        content_lines.append(line[1:])
    content = "\n".join(content_lines)
    if content_lines:
        content += "\n"
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_PATCH_FILE_BYTES:
        raise PatchError(f"文件超过 8 MiB 限制: {normalized}")
    atomic_write_bytes(path, encoded)
    diff = "".join(
        difflib.unified_diff([], content.splitlines(keepends=True), fromfile="/dev/null", tofile=normalized)
    )
    return {"action": "add", "path": normalized, "diff": diff}


def _apply_delete(root: Path, operation: PatchOperation) -> dict[str, object]:
    if operation.lines and any(operation.lines):
        raise PatchError(f"Delete File 后不能包含内容: {operation.path}")
    path, normalized = resolve_workspace_path(root, operation.path)
    if not path.is_file():
        raise PatchError(f"目标文件不存在: {normalized}")
    before = _read_utf8(path, normalized)
    try:
        path.unlink()
    except OSError as exc:
        raise PatchError(f"删除文件失败: {normalized}: {exc}") from exc
    diff = "".join(
        difflib.unified_diff(before.splitlines(keepends=True), [], fromfile=normalized, tofile="/dev/null")
    )
    return {"action": "delete", "path": normalized, "diff": diff}


def _apply_update(root: Path, operation: PatchOperation) -> dict[str, object]:
    source, normalized = resolve_workspace_path(root, operation.path)
    if not source.is_file():
        raise PatchError(f"目标文件不存在: {normalized}")
    before = _read_utf8(source, normalized)
    newline = "\r\n" if "\r\n" in before else "\n"
    trailing_newline = before.endswith(("\n", "\r"))
    current_lines = before.replace("\r\n", "\n").splitlines()
    updated_lines = _apply_hunks(current_lines, operation.lines, normalized)
    after = newline.join(updated_lines)
    if trailing_newline and updated_lines:
        after += newline
    encoded = after.encode("utf-8")
    if len(encoded) > MAX_PATCH_FILE_BYTES:
        raise PatchError(f"文件超过 8 MiB 限制: {normalized}")

    destination = source
    destination_name = normalized
    if operation.move_to is not None:
        destination, destination_name = resolve_workspace_path(root, operation.move_to)
        if destination.exists() and destination != source:
            raise PatchError(f"Move to 目标已存在: {destination_name}")

    atomic_write_bytes(destination, encoded)
    if destination != source:
        try:
            source.unlink()
        except OSError as exc:
            destination.unlink(missing_ok=True)
            raise PatchError(f"移动源文件删除失败: {normalized}: {exc}") from exc
    diff = "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=normalized,
            tofile=destination_name,
        )
    )
    return {
        "action": "move" if destination != source else "update",
        "path": destination_name,
        "diff": diff,
    }


def _apply_hunks(current: list[str], body: tuple[str, ...], path: str) -> list[str]:
    if not body:
        raise PatchError(f"Update File 缺少 patch hunk: {path}")
    result = list(current)
    index = 0
    search_from = 0
    saw_hunk = False
    while index < len(body):
        if not body[index].startswith("@@"):
            if body[index] == "":
                index += 1
                continue
            raise PatchError(f"Update File hunk 必须以 @@ 开始: {path}")
        saw_hunk = True
        index += 1
        hunk: list[str] = []
        while index < len(body) and not body[index].startswith("@@"):
            line = body[index]
            if line == "\\ No newline at end of file":
                index += 1
                continue
            if not line or line[0] not in {" ", "+", "-"}:
                raise PatchError(f"无效 hunk 行: {path}: {line}")
            hunk.append(line)
            index += 1
        old_lines = [line[1:] for line in hunk if line[0] in {" ", "-"}]
        new_lines = [line[1:] for line in hunk if line[0] in {" ", "+"}]
        if not old_lines:
            raise PatchError(f"hunk 至少需要一行上下文或删除内容: {path}")
        match = _find_unique_subsequence(result, old_lines, search_from)
        if match is None:
            raise PatchError(f"hunk 上下文未找到或不唯一: {path}")
        result[match : match + len(old_lines)] = new_lines
        search_from = match + len(new_lines)
    if not saw_hunk:
        raise PatchError(f"Update File 缺少 patch hunk: {path}")
    return result


def _find_unique_subsequence(haystack: list[str], needle: list[str], start: int) -> int | None:
    matches: list[int] = []
    upper = len(haystack) - len(needle) + 1
    for index in range(start, max(start, upper)):
        if haystack[index : index + len(needle)] == needle:
            matches.append(index)
            if len(matches) > 1:
                return None
    return matches[0] if matches else None


def _read_utf8(path: Path, normalized: str) -> str:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise PatchError(f"读取文件失败: {normalized}: {exc}") from exc
    if len(data) > MAX_PATCH_FILE_BYTES:
        raise PatchError(f"文件超过 8 MiB 限制: {normalized}")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PatchError(f"文件不是 UTF-8 文本: {normalized}") from exc
