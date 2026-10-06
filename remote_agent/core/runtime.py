from __future__ import annotations

import asyncio
import json
import os
import platform
import ssl
import socket
import sys
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection

from remote_agent.profiles.base import ProfileHandler

from .config import AgentConfigStore
from .errors import FatalAgentError
from .limits import MAX_CONCURRENT_REQUESTS_PER_AGENT
from .version import AGENT_VERSION, CORE_VERSION, PROTOCOL_VERSION


RECONNECT_MIN_SECONDS = 2
RECONNECT_MAX_SECONDS = 30


class RemoteAgent:
    def __init__(
        self,
        gateway_url: str,
        config_store: AgentConfigStore,
        enrollment_token: str | None,
        name: str,
        description: str,
        build_id: str,
        handlers: dict[str, ProfileHandler],
    ):
        if not handlers:
            raise FatalAgentError("Agent 至少需要加载一个 Profile Handler")
        self.gateway_url = gateway_url
        self.config_store = config_store
        self.enrollment_token = enrollment_token
        self.name = name
        self.description = description
        self.build_id = build_id
        self.handlers = handlers
        self.running: dict[str, asyncio.Task[None]] = {}
        self.request_profiles: dict[str, str] = {}
        self.send_lock = asyncio.Lock()

    @property
    def profile_ids(self) -> list[str]:
        return sorted(self.handlers)

    @property
    def profile_declarations(self) -> list[dict[str, Any]]:
        return [self.handlers[profile_id].declaration() for profile_id in self.profile_ids]

    def hello_message(self) -> dict[str, Any]:
        base: dict[str, Any] = {
            "v": PROTOCOL_VERSION,
            "type": "hello",
            "profiles": self.profile_declarations,
            "version": {
                "agent_version": AGENT_VERSION,
                "core_version": CORE_VERSION,
                "protocol_version": PROTOCOL_VERSION,
                "build_id": self.build_id,
            },
            "metadata": {
                "hostname": socket.gethostname(),
                "platform": platform.platform(),
                "python": platform.python_version(),
                "pid": os.getpid(),
            },
        }
        if self.enrollment_token:
            base.update(
                {
                    "enrollment_token": self.enrollment_token,
                    "name": self.name,
                    "description": self.description,
                }
            )
            return base
        config = self.config_store.load()
        if not config:
            raise FatalAgentError("首次运行需要提供 --token 完成 Agent 注册")
        base.update({"agent_id": config.get("agent_id"), "credential": config.get("credential")})
        return base

    async def send(self, websocket: ClientConnection, message: dict[str, Any]) -> None:
        async with self.send_lock:
            await websocket.send(json.dumps(message, ensure_ascii=False, separators=(",", ":")))

    async def run_request(self, websocket: ClientConnection, message: dict[str, Any]) -> None:
        request_id = message.get("request_id")
        profile_id = message.get("profile")
        try:
            if not isinstance(request_id, str):
                raise ValueError("request_id 无效")
            if not isinstance(profile_id, str) or profile_id not in self.handlers:
                raise ValueError(f"Agent 未加载 Profile: {profile_id}")
            action = message.get("action")
            if not isinstance(action, str) or not action:
                raise ValueError("action 无效")
            params = message.get("params")
            if not isinstance(params, dict):
                raise ValueError("params 必须是对象")
            result = await self.handlers[profile_id].execute(action, request_id, params)
            response = {
                "v": PROTOCOL_VERSION,
                "type": "result",
                "request_id": request_id,
                "ok": True,
                "result": result,
            }
        except asyncio.CancelledError:
            response = {
                "v": PROTOCOL_VERSION,
                "type": "result",
                "request_id": request_id,
                "ok": False,
                "error": "任务已取消",
            }
        except Exception as exc:
            response = {
                "v": PROTOCOL_VERSION,
                "type": "result",
                "request_id": request_id,
                "ok": False,
                "error": str(exc),
            }
        try:
            await self.send(websocket, response)
        finally:
            self.running.pop(request_id, None)
            self.request_profiles.pop(request_id, None)

    async def dispatch_request(
        self, websocket: ClientConnection, message: dict[str, Any]
    ) -> None:
        request_id = message.get("request_id")
        profile_id = message.get("profile")
        if not isinstance(request_id, str) or request_id in self.running:
            return
        if len(self.running) >= MAX_CONCURRENT_REQUESTS_PER_AGENT:
            await self.send(
                websocket,
                {
                    "v": PROTOCOL_VERSION,
                    "type": "result",
                    "request_id": request_id,
                    "ok": False,
                    "error": (
                        "Agent 当前忙碌；每台 Agent 最多同时执行 "
                        f"{MAX_CONCURRENT_REQUESTS_PER_AGENT} 个请求"
                    ),
                },
            )
            return
        if isinstance(profile_id, str):
            self.request_profiles[request_id] = profile_id
        task = asyncio.create_task(self.run_request(websocket, message))
        self.running[request_id] = task

    async def session(self, *, enroll_only: bool = False) -> None:
        async with websockets.connect(
            self.gateway_url,
            open_timeout=15,
            ping_interval=20,
            ping_timeout=20,
            max_size=4 * 1024 * 1024,
        ) as websocket:
            await self.send(websocket, self.hello_message())
            raw = await asyncio.wait_for(websocket.recv(), timeout=15)
            response = json.loads(raw)
            if not isinstance(response, dict) or response.get("v") != PROTOCOL_VERSION:
                raise FatalAgentError(
                    f"网关协议版本不兼容，需要 v{PROTOCOL_VERSION}；请更新网关或 Agent"
                )
            if response.get("type") == "error":
                raise FatalAgentError(str(response.get("error") or "Agent 认证失败"))
            if response.get("type") == "registered":
                self.config_store.save(
                    {
                        "gateway_url": self.gateway_url,
                        "agent_id": response["agent_id"],
                        "credential": response["credential"],
                    }
                )
                self.enrollment_token = None
                print(f"Agent 注册成功: {response['agent_id']}", flush=True)
            elif response.get("type") != "ready":
                raise FatalAgentError("网关返回了无效的握手响应")

            if enroll_only:
                if response.get("type") != "registered":
                    raise FatalAgentError("--enroll-only 仅用于首次注册新的 Agent")
                return

            profile_summary = ", ".join(
                f"{declaration['id']} [{_runtime_label(declaration['runtime'])}]"
                for declaration in self.profile_declarations
            )
            print(
                f"Agent {AGENT_VERSION} ({self.build_id}) 已连接: "
                f"{self.gateway_url} ({profile_summary})",
                flush=True,
            )
            async for raw_message in websocket:
                message = json.loads(raw_message)
                if not isinstance(message, dict) or message.get("v") != PROTOCOL_VERSION:
                    continue
                message_type = message.get("type")
                if message_type == "ping":
                    await self.send(
                        websocket,
                        {"v": PROTOCOL_VERSION, "type": "pong", "ts": message.get("ts")},
                    )
                elif message_type == "request":
                    await self.dispatch_request(websocket, message)
                elif message_type == "cancel":
                    request_id = message.get("request_id")
                    profile_id = self.request_profiles.get(request_id)
                    handler = self.handlers.get(profile_id) if profile_id else None
                    if handler is not None:
                        await handler.cancel(request_id)
                    task = self.running.get(request_id)
                    if task is not None:
                        task.cancel()

    async def enroll_once(self) -> None:
        try:
            await self.session(enroll_only=True)
        except FatalAgentError:
            raise
        except ssl.SSLCertVerificationError as exc:
            raise FatalAgentError(f"Gateway TLS 证书验证失败: {exc}") from exc
        except websockets.InvalidURI as exc:
            raise FatalAgentError(f"Gateway WebSocket 地址无效: {exc}") from exc
        except (
            OSError,
            TimeoutError,
            websockets.WebSocketException,
            json.JSONDecodeError,
        ) as exc:
            raise FatalAgentError(f"首次注册连接 Gateway 失败: {exc}") from exc

    async def run_forever(self) -> None:
        delay = RECONNECT_MIN_SECONDS
        while True:
            try:
                await self.session()
                delay = RECONNECT_MIN_SECONDS
            except FatalAgentError:
                raise
            except ssl.SSLCertVerificationError as exc:
                raise FatalAgentError(f"Gateway TLS 证书验证失败: {exc}") from exc
            except websockets.InvalidURI as exc:
                raise FatalAgentError(f"Gateway WebSocket 地址无效: {exc}") from exc
            except (
                OSError,
                TimeoutError,
                websockets.WebSocketException,
                json.JSONDecodeError,
            ) as exc:
                print(f"连接中断: {exc}; {delay} 秒后重试", file=sys.stderr, flush=True)
            finally:
                tasks = list(self.running.values())
                for task in tasks:
                    task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                self.running.clear()
                self.request_profiles.clear()
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_SECONDS)


def _runtime_label(runtime: dict[str, Any]) -> str:
    return str(
        runtime.get("dialect")
        or runtime.get("scope")
        or runtime.get("engine")
        or runtime.get("language")
        or "unknown"
    )
