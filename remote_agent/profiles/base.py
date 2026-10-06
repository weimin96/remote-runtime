from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class ProfileContext:
    """Runtime context shared by all Actions in one Profile."""

    workdir: Path


class ActionHandler(ABC):
    action_id: str

    @abstractmethod
    async def execute(
        self,
        request_id: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        """Execute one request for this Action."""

    async def cancel(self, request_id: str) -> None:
        """Cancel an active request when the Action supports cancellation."""


class ProfileHandler(ABC):
    profile_id: str

    def __init__(
        self,
        context: ProfileContext,
        actions: Mapping[str, ActionHandler],
    ):
        if not actions:
            raise ValueError(f"Profile {self.profile_id} 至少需要一个 Action")
        self.context = context
        self.actions = dict(actions)
        for action_id, action in self.actions.items():
            if action_id != action.action_id:
                raise ValueError(
                    f"Profile {self.profile_id} 的 Action 注册名与实现不一致: {action_id}"
                )
        self._request_actions: dict[str, ActionHandler] = {}

    @abstractmethod
    def runtime_metadata(self) -> dict[str, Any]:
        """Describe the concrete runtime selected for this Profile."""

    def declaration(self) -> dict[str, Any]:
        return {"id": self.profile_id, "runtime": self.runtime_metadata()}

    async def execute(
        self,
        action: str,
        request_id: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        """Route one request to a statically assembled Action."""
        handler = self.actions.get(action)
        if handler is None:
            raise ValueError(f"{self.profile_id} 不支持操作: {action}")
        self._request_actions[request_id] = handler
        try:
            return await handler.execute(request_id, params)
        finally:
            self._request_actions.pop(request_id, None)

    async def cancel(self, request_id: str) -> None:
        handler = self._request_actions.get(request_id)
        if handler is not None:
            await handler.cancel(request_id)
