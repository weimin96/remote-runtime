from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from remote_agent.core.errors import FatalAgentError

from .base import ProfileContext, ProfileHandler

ProfileFactory = Callable[[ProfileContext], ProfileHandler]


def _build_shell(context: ProfileContext) -> ProfileHandler:
    from .shell_v1 import ShellV1Profile

    return ShellV1Profile(context)


def _build_workspace(context: ProfileContext) -> ProfileHandler:
    from .workspace_v1 import WorkspaceV1Profile

    return WorkspaceV1Profile(context)


PROFILE_FACTORIES: dict[str, ProfileFactory] = {
    "shell.v1": _build_shell,
    "workspace.v1": _build_workspace,
}


def build_profile_handlers(
    profile_ids: tuple[str, ...] | list[str],
    workdir: Path,
) -> dict[str, ProfileHandler]:
    context = ProfileContext(workdir=workdir.resolve())
    handlers: dict[str, ProfileHandler] = {}
    for profile_id in profile_ids:
        factory = PROFILE_FACTORIES.get(profile_id)
        if factory is None:
            raise FatalAgentError(f"当前 Python Agent 未实现 Profile: {profile_id}")
        handler = factory(context)
        if handler.profile_id != profile_id:
            raise FatalAgentError(
                f"Profile 工厂返回了错误的 ID: {profile_id} -> {handler.profile_id}"
            )
        handlers[handler.profile_id] = handler
    return handlers
