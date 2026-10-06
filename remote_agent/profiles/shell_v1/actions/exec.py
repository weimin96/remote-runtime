from __future__ import annotations

from typing import Any

from remote_agent.profiles.base import ActionHandler

from ..executor import ShellExecutor


class ShellExecAction(ActionHandler):
    action_id = "exec"

    def __init__(self, executor: ShellExecutor):
        self.executor = executor

    async def execute(
        self,
        request_id: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        return await self.executor.execute(request_id, params)

    async def cancel(self, request_id: str) -> None:
        await self.executor.cancel(request_id)
