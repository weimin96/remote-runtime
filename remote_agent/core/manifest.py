from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .errors import FatalAgentError
from .version import AGENT_VERSION, CORE_VERSION


@dataclass(frozen=True, slots=True)
class AgentManifest:
    runtime: str
    agent_version: str
    core_version: int
    build_id: str
    profiles: tuple[str, ...]
    name: str | None = None
    description: str = ""


def default_manifest_path() -> Path:
    return Path(__file__).resolve().parents[1] / "manifest.json"


def load_manifest(path: Path | None = None) -> AgentManifest:
    manifest_path = (path or default_manifest_path()).expanduser().resolve()
    try:
        with manifest_path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise FatalAgentError(f"无法读取 Agent Manifest: {manifest_path}") from exc
    if not isinstance(raw, dict):
        raise FatalAgentError("Agent Manifest 必须是 JSON 对象")
    runtime = raw.get("runtime")
    agent_version = raw.get("agent_version")
    core_version = raw.get("core_version")
    build_id = raw.get("build_id")
    profiles = raw.get("profiles")
    agent = raw.get("agent", {})
    if runtime != "python":
        raise FatalAgentError(f"当前运行时不支持 Manifest runtime: {runtime}")
    if agent_version != AGENT_VERSION:
        raise FatalAgentError(f"Manifest agent_version 与当前代码不一致: {agent_version}")
    if core_version != CORE_VERSION:
        raise FatalAgentError(f"当前 Agent 不支持 core_version: {core_version}")
    if (
        not isinstance(build_id, str)
        or not build_id
        or len(build_id) > 80
        or not all(character.isalnum() or character in "._:-" for character in build_id)
    ):
        raise FatalAgentError("Agent Manifest 的 build_id 无效")
    if not isinstance(profiles, list) or not profiles or not all(
        isinstance(profile, str) and profile for profile in profiles
    ):
        raise FatalAgentError("Agent Manifest 必须声明至少一个 Profile")
    if not isinstance(agent, dict):
        raise FatalAgentError("Agent Manifest 的 agent 字段必须是对象")
    name = agent.get("name")
    description = agent.get("description", "")
    if name is not None and (not isinstance(name, str) or not name.strip()):
        raise FatalAgentError("Agent Manifest 的 name 无效")
    if not isinstance(description, str):
        raise FatalAgentError("Agent Manifest 的 description 无效")
    deduplicated = tuple(dict.fromkeys(profiles))
    return AgentManifest(
        runtime=runtime,
        agent_version=agent_version,
        core_version=core_version,
        build_id=build_id,
        profiles=deduplicated,
        name=name.strip() if isinstance(name, str) else None,
        description=description.strip(),
    )
