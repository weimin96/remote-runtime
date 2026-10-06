from __future__ import annotations

import asyncio
import uuid
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from .agent_hub import AgentConnection, AgentHub
from .agent_protocol import AGENT_PROTOCOL_VERSION, validate_agent_version
from .database import Database
from .profiles import (
    profile_ids,
    validate_profile_agent_compatibility,
    validate_profile_declarations,
)
from .security import hash_token, issue_token


def _text(value: object, field: str, maximum: int, required: bool = True) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是字符串")
    normalized = value.strip()
    if required and not normalized:
        raise ValueError(f"{field} 不能为空")
    if len(normalized) > maximum:
        raise ValueError(f"{field} 不能超过 {maximum} 个字符")
    return normalized


async def handle_agent_websocket(websocket: WebSocket, db: Database, hub: AgentHub) -> None:
    await websocket.accept()
    agent_id: str | None = None
    try:
        hello = await asyncio.wait_for(websocket.receive_json(), timeout=15)
        if not isinstance(hello, dict) or hello.get("type") != "hello":
            raise ValueError("无效的 Agent 握手消息")
        if hello.get("v") != AGENT_PROTOCOL_VERSION:
            raise ValueError(
                f"Agent 协议版本不兼容，需要 v{AGENT_PROTOCOL_VERSION}；请重新下载新版 Agent"
            )
        profile_declarations = validate_profile_declarations(hello.get("profiles"))
        profiles = profile_ids(profile_declarations)
        version = validate_agent_version(hello.get("version"), AGENT_PROTOCOL_VERSION)
        validate_profile_agent_compatibility(profile_declarations, version)

        enrollment_token = hello.get("enrollment_token")
        if isinstance(enrollment_token, str) and enrollment_token:
            name = _text(hello.get("name"), "name", 80)
            description = _text(hello.get("description", ""), "description", 500, required=False)
            credential = issue_token("agent")
            agent_id = str(uuid.uuid4())
            registered = db.register_agent(
                hash_token(enrollment_token),
                agent_id,
                credential.prefix,
                credential.digest,
                name,
                description,
                profile_declarations,
                version,
            )
            if registered is None:
                raise ValueError("注册令牌无效、已过期或已被使用")
            user_id = registered["user_id"]
            await websocket.send_json(
                {
                    "v": AGENT_PROTOCOL_VERSION,
                    "type": "registered",
                    "agent_id": agent_id,
                    "credential": credential.value,
                }
            )
        else:
            agent_id = _text(hello.get("agent_id"), "agent_id", 64)
            credential_value = _text(hello.get("credential"), "credential", 256)
            agent = db.authenticate_agent(agent_id, hash_token(credential_value))
            if agent is None:
                raise ValueError("Agent 设备凭据无效或已被撤销")
            if agent["profiles"] != profiles:
                raise ValueError("Agent Profile 与注册记录不一致，请重新注册 Agent")
            db.update_agent_runtime(agent_id, profile_declarations, version)
            user_id = agent["user_id"]
            await websocket.send_json(
                {"v": AGENT_PROTOCOL_VERSION, "type": "ready", "agent_id": agent_id}
            )

        connection = AgentConnection(agent_id, user_id, websocket)
        await hub.register(connection)
        db.touch_agent(agent_id)

        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict) or message.get("v") != AGENT_PROTOCOL_VERSION:
                continue
            message_type = message.get("type")
            if message_type == "pong":
                hub.record_pong(connection)
                db.touch_agent(agent_id)
            elif message_type == "result":
                await hub.resolve(connection, message)
    except (ValueError, asyncio.TimeoutError) as exc:
        await websocket.send_json(
            {"v": AGENT_PROTOCOL_VERSION, "type": "error", "error": str(exc)}
        )
        await websocket.close(code=4000, reason="认证失败")
    except WebSocketDisconnect:
        pass
    finally:
        if agent_id is not None:
            await hub.unregister(agent_id, websocket)
            db.touch_agent(agent_id)
