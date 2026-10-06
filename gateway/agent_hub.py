from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket
from remote_agent.core.limits import MAX_CONCURRENT_REQUESTS_PER_AGENT

from .agent_protocol import AGENT_PROTOCOL_VERSION


class AgentError(Exception):
    pass


class AgentOfflineError(AgentError):
    pass


class AgentCommandError(AgentError):
    pass


class AgentBusyError(AgentCommandError):
    pass


@dataclass(slots=True)
class AgentConnection:
    agent_id: str
    user_id: str
    websocket: WebSocket
    connected_at: float = field(default_factory=time.time)
    last_pong: float = field(default_factory=time.monotonic)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, message: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.websocket.send_json(message)


@dataclass(slots=True)
class PendingRequest:
    agent_id: str
    connection: AgentConnection
    future: asyncio.Future[dict[str, Any]]


class AgentHub:
    def __init__(self) -> None:
        self._connections: dict[str, AgentConnection] = {}
        self._pending: dict[str, PendingRequest] = {}
        self._lock = asyncio.Lock()

    async def register(self, connection: AgentConnection) -> None:
        async with self._lock:
            previous = self._connections.get(connection.agent_id)
            self._connections[connection.agent_id] = connection
            failed = []
            if previous is not None and previous is not connection:
                failed = self._remove_pending_for_connection(previous)
        self._fail_pending(failed, "Agent 已在新的连接上线")
        if previous is not None and previous.websocket is not connection.websocket:
            try:
                await previous.websocket.close(code=4001, reason="Agent 已在其他连接上线")
            except RuntimeError:
                pass

    async def unregister(self, agent_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            current = self._connections.get(agent_id)
            if current is None or current.websocket is not websocket:
                return
            self._connections.pop(agent_id, None)
            failed = self._remove_pending_for_connection(current)
        self._fail_pending(failed, "Agent 连接已断开")

    def _remove_pending_for_connection(
        self, connection: AgentConnection
    ) -> list[PendingRequest]:
        request_ids = [
            request_id
            for request_id, pending in self._pending.items()
            if pending.connection is connection
        ]
        return [self._pending.pop(request_id) for request_id in request_ids]

    @staticmethod
    def _fail_pending(pending_requests: list[PendingRequest], message: str) -> None:
        for pending in pending_requests:
            if not pending.future.done():
                pending.future.set_exception(AgentOfflineError(message))

    def is_online(self, agent_id: str) -> bool:
        return agent_id in self._connections

    def online_agent_ids(self) -> set[str]:
        return set(self._connections)

    async def execute(
        self,
        agent_id: str,
        profile: str,
        action: str,
        params: dict[str, Any],
        timeout: float,
    ) -> dict[str, Any]:
        connection = self._connections.get(agent_id)
        if connection is None:
            raise AgentOfflineError("Agent 当前离线")

        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        async with self._lock:
            if self._connections.get(agent_id) is not connection:
                raise AgentOfflineError("Agent 当前离线")
            active_requests = sum(
                1 for pending in self._pending.values() if pending.agent_id == agent_id
            )
            if active_requests >= MAX_CONCURRENT_REQUESTS_PER_AGENT:
                raise AgentBusyError(
                    "Agent 当前忙碌；每台 Agent 最多同时执行 "
                    f"{MAX_CONCURRENT_REQUESTS_PER_AGENT} 个请求"
                )
            self._pending[request_id] = PendingRequest(
                agent_id=agent_id,
                connection=connection,
                future=future,
            )

        try:
            await connection.send(
                {
                    "v": AGENT_PROTOCOL_VERSION,
                    "type": "request",
                    "request_id": request_id,
                    "profile": profile,
                    "action": action,
                    "params": params,
                }
            )
            message = await asyncio.wait_for(future, timeout=timeout + 5)
        except asyncio.TimeoutError as exc:
            await self._cancel_remote(connection, request_id)
            raise AgentCommandError("远程命令等待超时") from exc
        except asyncio.CancelledError:
            await self._cancel_remote(connection, request_id)
            raise
        except (RuntimeError, OSError) as exc:
            raise AgentOfflineError("无法向 Agent 发送请求") from exc
        finally:
            async with self._lock:
                self._pending.pop(request_id, None)

        if not message.get("ok"):
            raise AgentCommandError(str(message.get("error") or "远程执行失败"))
        result = message.get("result")
        if not isinstance(result, dict):
            raise AgentCommandError("Agent 返回了无效结果")
        return result

    async def _cancel_remote(self, connection: AgentConnection, request_id: str) -> None:
        try:
            await asyncio.shield(
                connection.send(
                    {
                        "v": AGENT_PROTOCOL_VERSION,
                        "type": "cancel",
                        "request_id": request_id,
                    }
                )
            )
        except Exception:
            pass

    async def resolve(self, connection: AgentConnection, message: dict[str, Any]) -> None:
        request_id = message.get("request_id")
        if not isinstance(request_id, str):
            return
        pending = self._pending.get(request_id)
        if (
            pending is None
            or pending.connection is not connection
            or pending.future.done()
        ):
            return
        pending.future.set_result(message)

    def record_pong(self, connection: AgentConnection) -> None:
        if self._connections.get(connection.agent_id) is connection:
            connection.last_pong = time.monotonic()

    async def heartbeat(self, timeout: float = 60) -> None:
        now = time.monotonic()
        stale: dict[str, AgentConnection] = {}
        for agent_id, connection in list(self._connections.items()):
            if now - connection.last_pong > timeout:
                stale[agent_id] = connection
                try:
                    await connection.websocket.close(code=4002, reason="心跳超时")
                except RuntimeError:
                    pass
                continue
            try:
                await connection.send(
                    {
                        "v": AGENT_PROTOCOL_VERSION,
                        "type": "ping",
                        "ts": int(time.time()),
                    }
                )
            except Exception:
                stale[agent_id] = connection
                try:
                    await connection.websocket.close()
                except RuntimeError:
                    pass
        for agent_id, connection in stale.items():
            await self.unregister(agent_id, connection.websocket)

    async def close_all(self) -> None:
        for connection in list(self._connections.values()):
            try:
                await connection.websocket.close(code=1001, reason="网关正在关闭")
            except RuntimeError:
                pass

    async def disconnect(self, agent_id: str, reason: str = "Agent 已被撤销") -> None:
        connection = self._connections.get(agent_id)
        if connection is None:
            return
        try:
            await connection.websocket.close(code=4003, reason=reason)
        except RuntimeError:
            pass
