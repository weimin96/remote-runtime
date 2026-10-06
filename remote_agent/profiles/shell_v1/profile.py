from __future__ import annotations

from typing import Any

from remote_agent.profiles.base import ProfileContext, ProfileHandler

from .actions import ShellExecAction
from .executor import ShellExecutor


class ShellV1Profile(ProfileHandler):
    profile_id = "shell.v1"

    def __init__(self, context: ProfileContext):
        self.executor = ShellExecutor(context.workdir)
        super().__init__(context, {"exec": ShellExecAction(self.executor)})

    def runtime_metadata(self) -> dict[str, Any]:
        return self.executor.runtime.public_metadata()
