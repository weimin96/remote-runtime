from __future__ import annotations

from copy import deepcopy
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any

from remote_agent.core.limits import MAX_CONCURRENT_REQUESTS_PER_AGENT

from .agent_protocol import version_tuple

SHELL_MAX_CAPTURE_BYTES = 2 * 1024 * 1024
SHELL_TRUNCATION_MARKER = "\n[output truncated by remote agent]\n"
WORKSPACE_MAX_FILE_BYTES = 8 * 1024 * 1024
WORKSPACE_MAX_READ_LINES = 2000
WORKSPACE_MAX_READ_BYTES = 50 * 1024
WORKSPACE_MAX_WRITE_BYTES = 2 * 1024 * 1024

PROFILE_REGISTRY: dict[str, dict[str, Any]] = {
    "shell.v1": {
        "id": "shell.v1",
        "name": "远程 Shell",
        "description": (
            "通过 Agent 启动时自动检测并声明的系统 Shell 执行命令，"
            "并返回标准输出、错误输出和退出码。"
        ),
        "status": "stable",
        "implementations": {
            "python": {
                "source": "shell_v1",
                "minimum_python": "3.11",
            }
        },
        "actions": [
            {
                "name": "exec",
                "mcp_tool": "remote_exec",
                "description": "执行一条 Shell 命令并等待其完成。",
                "parameters": [
                    {
                        "name": "command",
                        "type": "string",
                        "required": True,
                        "description": "符合该 Agent 所声明 Shell 方言的命令字符串。",
                    },
                    {
                        "name": "timeout",
                        "type": "integer",
                        "required": False,
                        "default": 300,
                        "minimum": 1,
                        "description": "命令超时秒数，最大值由网关策略限制。",
                    },
                ],
                "returns": [
                    {
                        "name": "stdout",
                        "type": "string",
                        "description": "命令的标准输出，使用替换字符处理无法解码的字节。",
                    },
                    {
                        "name": "stderr",
                        "type": "string",
                        "description": "命令的错误输出，使用替换字符处理无法解码的字节。",
                    },
                    {
                        "name": "exit_code",
                        "type": "integer",
                        "description": "Shell 进程退出码；通常 0 表示成功。",
                    },
                ],
                "errors": [
                    {
                        "name": "timeout",
                        "description": "超过 timeout 后终止本次命令的整个进程树。",
                    },
                    {
                        "name": "cancelled",
                        "description": "网关取消、连接断开或 Agent 离线时终止任务。",
                    },
                    {
                        "name": "invalid_result",
                        "description": "返回值不符合契约时由网关拒绝结果。",
                    },
                ],
            }
        ],
        "runtime_contract": {
            "selection": "Agent 启动时检测一次可用 Shell，并在该进程生命周期内固定使用。",
            "fields": [
                {"name": "os", "type": "string", "description": "远程设备操作系统。"},
                {
                    "name": "dialect",
                    "type": "string",
                    "description": "命令必须遵循的 Shell 方言。",
                },
                {
                    "name": "executable",
                    "type": "string",
                    "description": "Agent 实际选择的 Shell 可执行文件名。",
                },
            ],
            "dialects": [
                {
                    "id": "powershell",
                    "label": "PowerShell",
                    "systems": ["Windows"],
                    "detection": ["pwsh", "powershell.exe"],
                    "example": "Get-Location",
                },
                {
                    "id": "cmd",
                    "label": "CMD",
                    "systems": ["Windows"],
                    "detection": ["cmd.exe"],
                    "example": "cd",
                },
                {
                    "id": "posix-sh",
                    "label": "POSIX Shell",
                    "systems": ["Linux", "macOS"],
                    "detection": ["/bin/sh", "PATH 中的 sh"],
                    "example": "pwd",
                },
            ],
        },
        "limits": {
            "capture_bytes_per_stream": SHELL_MAX_CAPTURE_BYTES,
            "truncation_marker": SHELL_TRUNCATION_MARKER.strip(),
            "timeout_terminates_process_tree": True,
            "max_concurrent_requests_per_agent": MAX_CONCURRENT_REQUESTS_PER_AGENT,
        },
    },
    "workspace.v1": {
        "id": "workspace.v1",
        "name": "远程工作区",
        "description": (
            "在 Agent 启动时指定的工作目录内，以 UTF-8 文本契约读取、整体写入和精确编辑文件。"
        ),
        "status": "stable",
        "minimum_agent_version": "0.2.1",
        "implementations": {
            "python": {
                "source": "workspace_v1",
                "minimum_python": "3.11",
            }
        },
        "actions": [
            {
                "name": "read",
                "mcp_tool": "remote_read_file",
                "description": "读取工作目录内的 UTF-8 文本文件，可按行分段。",
                "parameters": [
                    {
                        "name": "path",
                        "type": "string",
                        "required": True,
                        "description": "工作目录下的相对路径，使用 / 分隔。",
                    },
                    {
                        "name": "offset",
                        "type": "integer",
                        "required": False,
                        "default": 1,
                        "minimum": 1,
                        "description": "从 1 开始的起始行号。",
                    },
                    {
                        "name": "limit",
                        "type": "integer",
                        "required": False,
                        "default": WORKSPACE_MAX_READ_LINES,
                        "minimum": 1,
                        "maximum": WORKSPACE_MAX_READ_LINES,
                        "description": "最多读取的行数，超出时返回 truncated。",
                    },
                ],
                "returns": [
                    {"name": "path", "type": "string", "description": "规范化后的工作区相对路径。"},
                    {"name": "content", "type": "string", "description": "读取到的 UTF-8 文本。"},
                    {"name": "offset", "type": "integer", "description": "实际起始行号。"},
                    {"name": "lines", "type": "integer", "description": "本次返回的行数。"},
                    {"name": "total_lines", "type": "integer", "description": "文件总行数。"},
                    {"name": "truncated", "type": "boolean", "description": "是否因范围或输出上限未返回完整内容。"},
                    {"name": "size", "type": "integer", "description": "文件 UTF-8 字节数。"},
                    {"name": "sha256", "type": "string", "description": "整个文件内容的 SHA-256，用于后续编辑冲突检测。"},
                ],
                "errors": [
                    {"name": "invalid_path", "description": "path 不是工作目录下的相对路径。"},
                    {"name": "not_found", "description": "目标文件不存在。"},
                    {"name": "invalid_encoding", "description": "文件不是有效的 UTF-8 文本。"},
                    {"name": "too_large", "description": "文件或读取范围超过协议限制。"},
                ],
            },
            {
                "name": "write",
                "mcp_tool": "remote_write_file",
                "description": "按显式文件版本前置条件，原子地创建或整体覆盖 UTF-8 文本文件。",
                "parameters": [
                    {
                        "name": "path",
                        "type": "string",
                        "required": True,
                        "description": "工作目录下的相对路径，使用 / 分隔。",
                    },
                    {
                        "name": "content",
                        "type": "string",
                        "required": True,
                        "description": "要写入的 UTF-8 文本；写入会整体替换文件。",
                    },
                    {
                        "name": "expected_sha256",
                        "type": "string",
                        "required": True,
                        "nullable": True,
                        "description": "传 null 时只允许新建；传当前文件 SHA-256 时只允许覆盖该版本。",
                    },
                ],
                "returns": [
                    {"name": "path", "type": "string", "description": "规范化后的工作区相对路径。"},
                    {"name": "bytes_written", "type": "integer", "description": "写入的 UTF-8 字节数。"},
                    {"name": "sha256", "type": "string", "description": "写入后整个文件内容的 SHA-256。"},
                    {"name": "changed", "type": "boolean", "description": "文件内容是否实际发生变化。"},
                ],
                "errors": [
                    {"name": "invalid_path", "description": "path 不是工作目录下的相对路径。"},
                    {"name": "permission_denied", "description": "目标或父目录不可写。"},
                    {"name": "conflict", "description": "文件存在性或当前版本与写入前置条件不一致。"},
                    {"name": "too_large", "description": "写入内容超过协议限制。"},
                ],
            },
            {
                "name": "edit",
                "mcp_tool": "remote_edit_file",
                "description": "按当前文件版本在工作目录内精确替换唯一一处文本，并返回 diff。",
                "parameters": [
                    {
                        "name": "path",
                        "type": "string",
                        "required": True,
                        "description": "工作目录下的相对路径，使用 / 分隔。",
                    },
                    {
                        "name": "old_text",
                        "type": "string",
                        "required": True,
                        "description": "必须在文件中恰好匹配一次的原文本。",
                    },
                    {
                        "name": "new_text",
                        "type": "string",
                        "required": True,
                        "description": "替换后的文本。",
                    },
                    {
                        "name": "expected_sha256",
                        "type": "string",
                        "required": True,
                        "description": "调用 read 得到的当前文件版本；不匹配时拒绝修改。",
                    },
                ],
                "returns": [
                    {"name": "path", "type": "string", "description": "规范化后的工作区相对路径。"},
                    {"name": "changed", "type": "boolean", "description": "文件内容是否发生变化。"},
                    {"name": "diff", "type": "string", "description": "修改前后的 unified diff。"},
                    {"name": "diff_truncated", "type": "boolean", "description": "diff 是否因输出上限被截断。"},
                    {"name": "first_changed_line", "type": "integer", "description": "首个修改行号。"},
                    {"name": "sha256", "type": "string", "description": "修改后整个文件内容的 SHA-256。"},
                ],
                "errors": [
                    {"name": "invalid_path", "description": "path 不是工作目录下的相对路径。"},
                    {"name": "conflict", "description": "文件版本已变化，拒绝覆盖新内容。"},
                    {"name": "not_found", "description": "old_text 未找到或文件不存在。"},
                    {"name": "ambiguous_match", "description": "old_text 匹配了多处内容，拒绝修改。"},
                    {"name": "invalid_encoding", "description": "文件不是有效的 UTF-8 文本。"},
                ],
            },
        ],
        "runtime_contract": {
            "selection": "Agent 启动时固定一个工作目录；所有 Action 只能访问该目录下的相对路径。",
            "fields": [
                {"name": "scope", "type": "string", "description": "固定为 workdir，不暴露绝对路径。"},
                {"name": "path_format", "type": "string", "description": "固定使用 relative-posix 路径。"},
                {"name": "encoding", "type": "string", "description": "固定使用 UTF-8 文本。"},
                {"name": "max_file_bytes", "type": "integer", "description": "单文件最大字节数。"},
            ],
        },
        "limits": {
            "max_file_bytes": WORKSPACE_MAX_FILE_BYTES,
            "max_read_lines": WORKSPACE_MAX_READ_LINES,
            "max_read_bytes": WORKSPACE_MAX_READ_BYTES,
            "max_write_bytes": WORKSPACE_MAX_WRITE_BYTES,
            "atomic_write": True,
            "optimistic_concurrency": True,
        },
    }
}

SHELL_DIALECTS: dict[str, set[str]] = {
    "powershell": {"windows"},
    "cmd": {"windows"},
    "posix-sh": {"linux", "macos", "posix"},
}


def validate_profiles(profiles: object) -> list[str]:
    if not isinstance(profiles, list):
        raise ValueError("profiles 必须是数组")
    normalized: list[str] = []
    for profile in profiles:
        if not isinstance(profile, str) or profile not in PROFILE_REGISTRY:
            raise ValueError(f"不支持的 Profile: {profile}")
        if profile not in normalized:
            normalized.append(profile)
    if not normalized:
        raise ValueError("Agent 至少需要实现一个标准 Profile")
    return normalized


def validate_profile_declarations(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("profiles 必须是结构化数组，请重新下载新版 Agent")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for declaration in value:
        if not isinstance(declaration, dict):
            raise ValueError("Agent Profile 声明格式已升级，请重新下载新版 Agent")
        profile_id = declaration.get("id")
        if not isinstance(profile_id, str) or profile_id not in PROFILE_REGISTRY:
            raise ValueError(f"不支持的 Profile: {profile_id}")
        if profile_id in seen:
            continue
        runtime = declaration.get("runtime")
        if profile_id == "shell.v1":
            runtime = _validate_shell_runtime(runtime)
        elif profile_id == "workspace.v1":
            runtime = _validate_workspace_runtime(runtime)
        elif not isinstance(runtime, dict):
            raise ValueError(f"Profile {profile_id} 缺少 runtime 声明")
        normalized.append({"id": profile_id, "runtime": runtime})
        seen.add(profile_id)
    if not normalized:
        raise ValueError("Agent 至少需要实现一个标准 Profile")
    return normalized


def _validate_shell_runtime(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError("shell.v1 必须声明运行时 Shell")
    operating_system = value.get("os")
    dialect = value.get("dialect")
    executable = value.get("executable")
    if not isinstance(operating_system, str) or operating_system not in {
        "windows",
        "linux",
        "macos",
        "posix",
    }:
        raise ValueError("shell.v1 runtime.os 无效")
    if not isinstance(dialect, str) or dialect not in SHELL_DIALECTS:
        raise ValueError("shell.v1 runtime.dialect 无效")
    if operating_system not in SHELL_DIALECTS[dialect]:
        raise ValueError("shell.v1 的操作系统与 Shell 方言不匹配")
    if not isinstance(executable, str) or not executable.strip() or len(executable) > 128:
        raise ValueError("shell.v1 runtime.executable 无效")
    return {
        "os": operating_system,
        "dialect": dialect,
        "executable": executable.strip(),
    }


def _validate_workspace_runtime(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("workspace.v1 必须声明工作区运行时")
    if value.get("scope") != "workdir":
        raise ValueError("workspace.v1 runtime.scope 必须是 workdir")
    if value.get("path_format") != "relative-posix":
        raise ValueError("workspace.v1 runtime.path_format 必须是 relative-posix")
    if value.get("encoding") != "utf-8":
        raise ValueError("workspace.v1 runtime.encoding 必须是 utf-8")
    if value.get("max_file_bytes") != WORKSPACE_MAX_FILE_BYTES:
        raise ValueError("workspace.v1 runtime.max_file_bytes 与协议限制不一致")
    return {
        "scope": "workdir",
        "path_format": "relative-posix",
        "encoding": "utf-8",
        "max_file_bytes": WORKSPACE_MAX_FILE_BYTES,
    }


def profile_ids(declarations: list[dict[str, Any]]) -> list[str]:
    return [declaration["id"] for declaration in declarations]


def validate_profile_agent_compatibility(
    declarations: list[dict[str, Any]], version: dict[str, Any]
) -> None:
    agent_version = version_tuple(version.get("agent_version"))
    if agent_version is None:
        raise ValueError("Agent agent_version 无效")
    for declaration in declarations:
        profile_id = declaration["id"]
        minimum = PROFILE_REGISTRY[profile_id].get("minimum_agent_version")
        if not isinstance(minimum, str):
            continue
        minimum_version = version_tuple(minimum)
        if minimum_version is None:
            raise RuntimeError(f"Profile {profile_id} 的最低 Agent 版本配置无效")
        if agent_version < minimum_version:
            raise ValueError(
                f"{profile_id} 需要 Agent {minimum} 或更高版本；"
                f"当前版本为 {version['agent_version']}，请重新从工作台组装 Agent"
            )
def describe_profile_declarations(
    declarations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    descriptions: list[dict[str, Any]] = []
    for declaration in declarations:
        profile_id = declaration.get("id")
        if profile_id not in PROFILE_REGISTRY:
            continue
        description = deepcopy(PROFILE_REGISTRY[profile_id])
        description["runtime"] = deepcopy(declaration.get("runtime", {}))
        descriptions.append(description)
    return descriptions


def profile_names(profile_ids: list[str]) -> list[str]:
    return [
        PROFILE_REGISTRY[profile]["name"]
        for profile in profile_ids
        if profile in PROFILE_REGISTRY
    ]


def public_profile_catalog() -> list[dict[str, Any]]:
    catalog: list[dict[str, Any]] = []
    for definition in PROFILE_REGISTRY.values():
        catalog.append(
            {
                "id": definition["id"],
                "name": definition["name"],
                "description": definition["description"],
                "status": definition["status"],
                "minimum_agent_version": definition.get("minimum_agent_version"),
                "runtimes": sorted(definition["implementations"]),
                "actions": deepcopy(definition["actions"]),
                "runtime_contract": deepcopy(definition.get("runtime_contract", {})),
                "limits": deepcopy(definition.get("limits", {})),
            }
        )
    return catalog


def profile_mcp_tools() -> set[str]:
    return {
        action["mcp_tool"]
        for definition in PROFILE_REGISTRY.values()
        for action in definition.get("actions", [])
        if isinstance(action.get("mcp_tool"), str) and action["mcp_tool"]
    }


def profile_action_mcp_tool(profile_id: str, action: str) -> str:
    definition = PROFILE_REGISTRY.get(profile_id)
    if definition is None:
        raise ValueError(f"不支持的 Profile: {profile_id}")
    for action_definition in definition.get("actions", []):
        if action_definition.get("name") == action:
            tool = action_definition.get("mcp_tool")
            if isinstance(tool, str) and tool:
                return tool
            break
    raise ValueError(f"Profile {profile_id} 不支持操作: {action}")


def validate_profile_result(
    profile_id: str, action: str, result: dict[str, Any]
) -> dict[str, Any]:
    if profile_id == "workspace.v1":
        return _validate_workspace_result(action, result)
    if profile_id != "shell.v1" or action != "exec":
        raise ValueError(f"不支持的 Profile 操作: {profile_id}/{action}")
    stdout = result.get("stdout")
    stderr = result.get("stderr")
    exit_code = result.get("exit_code")
    if not isinstance(stdout, str) or not isinstance(stderr, str):
        raise ValueError("Agent 返回的 stdout/stderr 必须是字符串")
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        raise ValueError("Agent 返回的 exit_code 必须是整数")
    # Invalid source bytes may expand to the three-byte UTF-8 replacement character.
    maximum = SHELL_MAX_CAPTURE_BYTES * 3 + len(SHELL_TRUNCATION_MARKER.encode("utf-8"))
    if len(stdout.encode("utf-8")) > maximum or len(stderr.encode("utf-8")) > maximum:
        raise ValueError("Agent 返回的 Shell 输出超过协议限制")
    return {"stdout": stdout, "stderr": stderr, "exit_code": exit_code}


def _validate_workspace_result(action: str, result: dict[str, Any]) -> dict[str, Any]:
    path = result.get("path")
    sha256 = result.get("sha256")
    path_object = PurePosixPath(path) if isinstance(path, str) else None
    windows_path = PureWindowsPath(path) if isinstance(path, str) else None
    if (
        not isinstance(path, str)
        or not path
        or path_object is None
        or path_object.is_absolute()
        or windows_path is None
        or windows_path.is_absolute()
        or windows_path.drive
        or ".." in path_object.parts
    ):
        raise ValueError("Agent 返回的 workspace path 无效")
    if (
        not isinstance(sha256, str)
        or len(sha256) != 64
        or any(character not in "0123456789abcdefABCDEF" for character in sha256)
    ):
        raise ValueError("Agent 返回的 workspace sha256 无效")
    if action == "read":
        content = result.get("content")
        offset = result.get("offset")
        lines = result.get("lines")
        total_lines = result.get("total_lines")
        truncated = result.get("truncated")
        size = result.get("size")
        if not isinstance(content, str):
            raise ValueError("Agent 返回的 workspace content 必须是字符串")
        if len(content.encode("utf-8")) > WORKSPACE_MAX_READ_BYTES:
            raise ValueError("Agent 返回的 workspace content 超过限制")
        if (
            not isinstance(offset, int)
            or isinstance(offset, bool)
            or offset < 1
            or not isinstance(lines, int)
            or isinstance(lines, bool)
            or lines < 0
            or not isinstance(total_lines, int)
            or isinstance(total_lines, bool)
            or total_lines < 0
            or not isinstance(truncated, bool)
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
        ):
            raise ValueError("Agent 返回的 workspace read 字段无效")
        return {
            "path": path,
            "content": content,
            "offset": offset,
            "lines": lines,
            "total_lines": total_lines,
            "truncated": truncated,
            "size": size,
            "sha256": sha256.lower(),
        }
    if action == "write":
        bytes_written = result.get("bytes_written")
        changed = result.get("changed")
        if (
            not isinstance(bytes_written, int)
            or isinstance(bytes_written, bool)
            or bytes_written < 0
            or bytes_written > WORKSPACE_MAX_WRITE_BYTES
            or not isinstance(changed, bool)
        ):
            raise ValueError("Agent 返回的 workspace write 字段无效")
        return {
            "path": path,
            "bytes_written": bytes_written,
            "sha256": sha256.lower(),
            "changed": changed,
        }
    if action == "edit":
        changed = result.get("changed")
        diff = result.get("diff")
        diff_truncated = result.get("diff_truncated")
        first_changed_line = result.get("first_changed_line")
        if (
            not isinstance(changed, bool)
            or not isinstance(diff, str)
            or len(diff.encode("utf-8")) > WORKSPACE_MAX_READ_BYTES
            or not isinstance(diff_truncated, bool)
            or not isinstance(first_changed_line, int)
            or isinstance(first_changed_line, bool)
            or first_changed_line < 1
        ):
            raise ValueError("Agent 返回的 workspace edit 字段无效")
        return {
            "path": path,
            "changed": changed,
            "diff": diff,
            "diff_truncated": diff_truncated,
            "first_changed_line": first_changed_line,
            "sha256": sha256.lower(),
        }
    raise ValueError(f"不支持的 workspace.v1 操作: {action}")
