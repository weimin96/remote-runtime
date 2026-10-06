from __future__ import annotations

import re
from typing import Any

from remote_agent.core.version import (
    AGENT_VERSION as CURRENT_AGENT_VERSION,
    CORE_VERSION as CURRENT_CORE_VERSION,
    PROTOCOL_VERSION as AGENT_PROTOCOL_VERSION,
)

_VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
_BUILD_ID_PATTERN = re.compile(r"^[0-9A-Za-z._:-]{1,80}$")


def validate_agent_version(value: object, protocol_version: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Agent 缺少版本信息，请重新下载最新版 Agent")
    agent_version = value.get("agent_version")
    core_version = value.get("core_version")
    declared_protocol = value.get("protocol_version")
    build_id = value.get("build_id")
    if not isinstance(agent_version, str) or not _VERSION_PATTERN.fullmatch(agent_version):
        raise ValueError("Agent agent_version 无效")
    if not isinstance(core_version, int) or isinstance(core_version, bool) or core_version < 1:
        raise ValueError("Agent core_version 无效")
    if declared_protocol != protocol_version:
        raise ValueError("Agent version.protocol_version 与握手协议版本不一致")
    if not isinstance(build_id, str) or not _BUILD_ID_PATTERN.fullmatch(build_id):
        raise ValueError("Agent build_id 无效")
    return {
        "agent_version": agent_version,
        "core_version": core_version,
        "protocol_version": protocol_version,
        "build_id": build_id,
    }


def agent_version_status(version: dict[str, Any]) -> str:
    if not version:
        return "unknown"
    if version.get("protocol_version") != AGENT_PROTOCOL_VERSION:
        return "incompatible"
    agent_version = version_tuple(version.get("agent_version"))
    current_version = version_tuple(CURRENT_AGENT_VERSION)
    core_version = version.get("core_version")
    if agent_version is None or not isinstance(core_version, int):
        return "unknown"
    if agent_version > current_version or core_version > CURRENT_CORE_VERSION:
        return "newer"
    if agent_version < current_version or core_version < CURRENT_CORE_VERSION:
        return "update_available"
    return "current"


def version_tuple(value: object) -> tuple[int, int, int] | None:
    if not isinstance(value, str) or not _VERSION_PATTERN.fullmatch(value):
        return None
    return tuple(int(part) for part in value.split("."))
