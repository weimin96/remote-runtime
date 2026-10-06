from __future__ import annotations

import asyncio
import base64
import json
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from unittest.mock import AsyncMock, patch

import websockets
from websockets.http11 import Response

from gateway.agent_protocol import (
    AGENT_PROTOCOL_VERSION,
    CURRENT_AGENT_VERSION,
    CURRENT_CORE_VERSION,
)
from gateway.profiles import SHELL_MAX_CAPTURE_BYTES, SHELL_TRUNCATION_MARKER
from remote_agent.core import (
    AGENT_VERSION,
    CORE_VERSION,
    AgentConfig,
    EnvironmentAgentConfig,
    FatalAgentError,
    RemoteAgent,
    load_manifest,
)
from remote_agent.core.runtime import PROTOCOL_VERSION
from remote_agent.core.limits import MAX_CONCURRENT_REQUESTS_PER_AGENT
from remote_agent.profiles import build_profile_handlers
from remote_agent.profiles.shell_v1 import MAX_CAPTURE_BYTES, TRUNCATION_MARKER


class RemoteAgentProfileTests(unittest.TestCase):
    def test_manifest_selects_actual_handlers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "runtime": "python",
                        "agent_version": AGENT_VERSION,
                        "core_version": CORE_VERSION,
                        "build_id": "profile-test",
                        "profiles": ["shell.v1"],
                    }
                ),
                encoding="utf-8",
            )
            manifest = load_manifest(manifest_path)
            handlers = build_profile_handlers(manifest.profiles, root)
            agent = RemoteAgent(
                gateway_url="ws://example.test/ws/agent",
                config_store=AgentConfig(root / "config.json"),
                enrollment_token="enroll_test",
                name="test",
                description="",
                build_id=manifest.build_id,
                handlers=handlers,
            )
        self.assertEqual(agent.profile_ids, ["shell.v1"])
        hello = agent.hello_message()
        self.assertEqual(PROTOCOL_VERSION, AGENT_PROTOCOL_VERSION)
        self.assertEqual(AGENT_VERSION, CURRENT_AGENT_VERSION)
        self.assertEqual(CORE_VERSION, CURRENT_CORE_VERSION)
        self.assertEqual(hello["v"], 2)
        self.assertEqual(
            hello["version"],
            {
                "agent_version": CURRENT_AGENT_VERSION,
                "core_version": CURRENT_CORE_VERSION,
                "protocol_version": AGENT_PROTOCOL_VERSION,
                "build_id": "profile-test",
            },
        )
        self.assertEqual(hello["profiles"][0]["id"], "shell.v1")
        self.assertIn(
            hello["profiles"][0]["runtime"]["dialect"],
            {"powershell", "cmd", "posix-sh"},
        )
        self.assertEqual(MAX_CAPTURE_BYTES, SHELL_MAX_CAPTURE_BYTES)
        self.assertEqual(TRUNCATION_MARKER.decode("ascii"), SHELL_TRUNCATION_MARKER)

    def test_environment_config_reconnects_with_existing_identity(self) -> None:
        config = {
            "gateway_url": "wss://gateway.example/ws/agent",
            "agent_id": "agent-ci-test",
            "credential": "agent_ci_secret",
        }
        environment = {
            "REMOTE_AGENT_CONFIG_B64": base64.b64encode(
                json.dumps(config).encode("utf-8")
            ).decode("ascii")
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = RemoteAgent(
                gateway_url=config["gateway_url"],
                config_store=EnvironmentAgentConfig(
                    "REMOTE_AGENT_CONFIG_B64", environment=environment
                ),
                enrollment_token=None,
                name="CI Agent",
                description="",
                build_id="ci-test",
                handlers=build_profile_handlers(["shell.v1"], root),
            )
            hello = agent.hello_message()

        self.assertEqual(hello["agent_id"], config["agent_id"])
        self.assertEqual(hello["credential"], config["credential"])
        self.assertNotIn("enrollment_token", hello)
        self.assertNotIn("REMOTE_AGENT_CONFIG_B64", environment)

    def test_workspace_profile_is_composed_from_three_actions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            handlers = build_profile_handlers(["workspace.v1"], Path(directory))
            handler = handlers["workspace.v1"]
        self.assertEqual(set(handler.actions), {"read", "write", "edit"})
        self.assertEqual(handler.declaration()["runtime"]["scope"], "workdir")

    def test_unknown_profile_cannot_be_declared_without_handler(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FatalAgentError):
                build_profile_handlers(["gpio.v1"], Path(directory))


class FakeAgentWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send(self, payload: str) -> None:
        self.messages.append(json.loads(payload))


class RemoteAgentConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_agent_rejects_request_above_local_concurrency_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = RemoteAgent(
                gateway_url="ws://example.test/ws/agent",
                config_store=AgentConfig(root / "config.json"),
                enrollment_token="enroll_test",
                name="test",
                description="",
                build_id="concurrency-test",
                handlers=build_profile_handlers(["shell.v1"], root),
            )
            running = [asyncio.create_task(asyncio.sleep(60)) for _ in range(MAX_CONCURRENT_REQUESTS_PER_AGENT)]
            agent.running.update({f"running-{index}": task for index, task in enumerate(running)})
            websocket = FakeAgentWebSocket()
            try:
                await agent.dispatch_request(
                    websocket,
                    {
                        "type": "request",
                        "request_id": "overflow",
                        "profile": "shell.v1",
                        "action": "exec",
                        "params": {"command": "pwd"},
                    },
                )
            finally:
                for task in running:
                    task.cancel()
                await asyncio.gather(*running, return_exceptions=True)
        self.assertEqual(len(agent.running), MAX_CONCURRENT_REQUESTS_PER_AGENT)
        self.assertEqual(websocket.messages[0]["request_id"], "overflow")
        self.assertFalse(websocket.messages[0]["ok"])
        self.assertIn("Agent 当前忙碌", websocket.messages[0]["error"])

    async def test_temporary_websocket_handshake_failure_retries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = RemoteAgent(
                gateway_url="ws://example.test/ws/agent",
                config_store=AgentConfig(Path(directory) / "config.json"),
                enrollment_token="enroll_test",
                name="test",
                description="",
                build_id="retry-test",
                handlers=build_profile_handlers(["shell.v1"], Path(directory)),
            )
            agent.session = AsyncMock(
                side_effect=[
                    websockets.InvalidStatus(
                        Response(503, "Service Unavailable", websockets.Headers())
                    ),
                    FatalAgentError("stop"),
                ]
            )
            with patch("remote_agent.core.runtime.asyncio.sleep", new=AsyncMock()) as sleep:
                with redirect_stderr(StringIO()) as stderr:
                    with self.assertRaisesRegex(FatalAgentError, "stop"):
                        await agent.run_forever()

        self.assertEqual(agent.session.await_count, 2)
        sleep.assert_awaited_once_with(2)
        self.assertIn("2 秒后重试", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
