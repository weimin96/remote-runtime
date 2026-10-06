from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient

from gateway.agent_protocol import CURRENT_AGENT_VERSION, CURRENT_CORE_VERSION
from gateway.app import create_app
from gateway.config import Settings
from remote_agent.core.limits import MAX_CONCURRENT_REQUESTS_PER_AGENT


SHELL_DECLARATIONS = [
    {
        "id": "shell.v1",
        "runtime": {
            "os": "windows",
            "dialect": "powershell",
            "executable": "powershell.exe",
        },
    }
]
WORKSPACE_DECLARATIONS = [
    {
        "id": "workspace.v1",
        "runtime": {
            "scope": "workdir",
            "path_format": "relative-posix",
            "encoding": "utf-8",
            "max_file_bytes": 8 * 1024 * 1024,
        },
    }
]
AGENT_VERSION = {
    "agent_version": CURRENT_AGENT_VERSION,
    "core_version": CURRENT_CORE_VERSION,
    "protocol_version": 2,
    "build_id": "web-test-build",
}


class WebApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        settings = Settings(
            host="127.0.0.1",
            port=8000,
            public_url="http://testserver",
            data_dir=root,
            database_path=root / "test.db",
            session_days=1,
            enrollment_minutes=30,
            max_command_timeout=3600,
            secure_cookies=False,
        )
        self.client_context = TestClient(create_app(settings))
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.tempdir.cleanup()

    def register(self, email: str = "owner@example.com") -> None:
        response = self.client.post(
            "/api/auth/register",
            json={"email": email, "password": "correct horse battery staple"},
        )
        self.assertEqual(response.status_code, 201, response.text)

    def test_register_create_and_revoke_mcp_key(self) -> None:
        self.register()
        created = self.client.post("/api/mcp-keys", json={"name": "Claude Desktop"})
        self.assertEqual(created.status_code, 201, created.text)
        payload = created.json()
        self.assertTrue(payload["secret"].startswith("mcp_"))

        listed = self.client.get("/api/mcp-keys").json()["keys"]
        self.assertEqual(len(listed), 1)
        self.assertNotIn("secret", listed[0])
        self.assertEqual(self.client.delete(f"/api/mcp-keys/{listed[0]['id']}").status_code, 204)
        self.assertIsNotNone(self.client.get("/api/mcp-keys").json()["keys"][0]["revoked_at"])

    def test_web_responses_include_security_headers(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")

        installer = self.client.get("/install-agent.sh")
        self.assertEqual(installer.status_code, 200)
        self.assertIn("text/x-shellscript", installer.headers["content-type"])
        self.assertEqual(installer.headers["cache-control"], "no-store")
        self.assertIn("--bundle-id", installer.text)

        upgrader = self.client.get("/upgrade-agent.sh")
        self.assertEqual(upgrader.status_code, 200)
        self.assertIn("text/x-shellscript", upgrader.headers["content-type"])
        self.assertEqual(upgrader.headers["cache-control"], "no-store")
        self.assertIn("/runtime-download", upgrader.text)
        self.assertEqual(self.client.get("/assets/install-agent.sh").status_code, 404)
        self.assertEqual(self.client.get("/assets/upgrade-agent.sh").status_code, 404)

    def test_enrollment_registers_agent_and_cannot_be_reused(self) -> None:
        self.register()
        created = self.client.post("/api/enrollment-tokens", json={"name": "GPU Notebook"})
        self.assertEqual(created.status_code, 201, created.text)
        secret = created.json()["secret"]

        hello = {
            "v": 2,
            "type": "hello",
            "enrollment_token": secret,
            "name": "GPU Notebook",
            "description": "模型训练环境",
            "profiles": SHELL_DECLARATIONS,
            "version": AGENT_VERSION,
        }
        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(hello)
            registered = websocket.receive_json()
            self.assertEqual(registered["type"], "registered")
            agents = self.client.get("/api/agents").json()["agents"]
            self.assertEqual(len(agents), 1)
            self.assertTrue(agents[0]["online"])
            self.assertEqual(agents[0]["capabilities"], ["远程 Shell"])
            self.assertEqual(agents[0]["profile_declarations"], SHELL_DECLARATIONS)
            self.assertFalse(agents[0]["requires_reenrollment"])
            self.assertEqual(agents[0]["version"], AGENT_VERSION)
            self.assertEqual(agents[0]["version_status"], "current")
            self.assertEqual(agents[0]["shell_policy"]["mode"], "off")
            details = self.client.get(f"/api/agents/{agents[0]['id']}").json()["agent"]
            self.assertEqual(details["profile_details"][0]["runtime"]["dialect"], "powershell")
            action = details["profile_details"][0]["actions"][0]
            self.assertEqual(action["name"], "exec")
            self.assertEqual(
                [field["name"] for field in action["returns"]],
                ["stdout", "stderr", "exit_code"],
            )

            updated = self.client.patch(
                f"/api/agents/{agents[0]['id']}/shell-policy", json={"mode": "standard"}
            )
            self.assertEqual(updated.status_code, 200, updated.text)
            self.assertEqual(updated.json()["agent"]["shell_policy"]["mode"], "standard")

            invalid = self.client.patch(
                f"/api/agents/{agents[0]['id']}/shell-policy", json={"mode": "strict"}
            )
            self.assertEqual(invalid.status_code, 422)

        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(hello)
            error = websocket.receive_json()
            self.assertEqual(error["type"], "error")
            self.assertIn("已过期或已被使用", error["error"])

    def test_manual_enrollment_only_issues_token_and_source_command(self) -> None:
        self.register()
        created = self.client.post("/api/enrollment-tokens", json={"name": "CI Manual"})
        self.assertEqual(created.status_code, 201, created.text)
        payload = created.json()
        self.assertTrue(payload["secret"].startswith("enroll_"))
        self.assertIn("python agent.py", payload["command"])
        self.assertNotIn("--name", payload["command"])
        self.assertEqual(self.client.get("/api/agent-bundles").json()["bundles"], [])

    def test_profile_catalog_exposes_detailed_shell_contract(self) -> None:
        self.register()
        profile = self.client.get("/api/profile-catalog").json()["profiles"][0]
        self.assertEqual(profile["id"], "shell.v1")
        self.assertEqual(
            [dialect["id"] for dialect in profile["runtime_contract"]["dialects"]],
            ["powershell", "cmd", "posix-sh"],
        )
        action = profile["actions"][0]
        self.assertEqual(action["name"], "exec")
        self.assertEqual(action["mcp_tool"], "remote_exec")
        self.assertEqual(action["parameters"][1]["default"], 300)
        self.assertEqual(
            [field["name"] for field in action["returns"]],
            ["stdout", "stderr", "exit_code"],
        )
        self.assertEqual(
            [error["name"] for error in action["errors"]],
            ["timeout", "cancelled", "invalid_result"],
        )
        self.assertEqual(profile["limits"]["capture_bytes_per_stream"], 2 * 1024 * 1024)
        self.assertEqual(
            profile["limits"]["max_concurrent_requests_per_agent"],
            MAX_CONCURRENT_REQUESTS_PER_AGENT,
        )
        profiles = self.client.get("/api/profile-catalog").json()["profiles"]
        workspace = next(item for item in profiles if item["id"] == "workspace.v1")
        self.assertEqual(workspace["minimum_agent_version"], "0.2.1")

    def test_old_agent_protocol_is_rejected_with_upgrade_message(self) -> None:
        self.register()
        created = self.client.post("/api/enrollment-tokens", json={"name": "Old Agent"})
        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(
                {
                    "v": 1,
                    "type": "hello",
                    "enrollment_token": created.json()["secret"],
                    "name": "Old Agent",
                    "description": "",
                    "profiles": ["shell.v1"],
                }
            )
            error = websocket.receive_json()
        self.assertEqual(error["v"], 2)
        self.assertIn("协议版本不兼容", error["error"])
        self.assertIn("重新下载新版 Agent", error["error"])

    def test_protocol_v2_requires_version_metadata(self) -> None:
        self.register()
        created = self.client.post("/api/enrollment-tokens", json={"name": "No Version"})
        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(
                {
                    "v": 2,
                    "type": "hello",
                    "enrollment_token": created.json()["secret"],
                    "name": "No Version",
                    "description": "",
                    "profiles": SHELL_DECLARATIONS,
                }
            )
            error = websocket.receive_json()
        self.assertIn("缺少版本信息", error["error"])

    def test_old_workspace_agent_is_rejected_before_token_is_consumed(self) -> None:
        self.register()
        created = self.client.post(
            "/api/enrollment-tokens", json={"name": "Old Workspace Agent"}
        )
        secret = created.json()["secret"]
        hello = {
            "v": 2,
            "type": "hello",
            "enrollment_token": secret,
            "name": "Workspace Agent",
            "description": "",
            "profiles": WORKSPACE_DECLARATIONS,
            "version": {
                "agent_version": "0.2.0",
                "core_version": 5,
                "protocol_version": 2,
                "build_id": "old-workspace",
            },
        }
        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(hello)
            error = websocket.receive_json()
        self.assertEqual(error["type"], "error")
        self.assertIn("workspace.v1 需要 Agent 0.2.1", error["error"])
        self.assertIn("重新从工作台组装", error["error"])

        hello["version"]["agent_version"] = CURRENT_AGENT_VERSION
        hello["version"]["build_id"] = "current-workspace"
        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(hello)
            registered = websocket.receive_json()
        self.assertEqual(registered["type"], "registered")

    def test_agent_is_hidden_from_another_user(self) -> None:
        self.register()
        created = self.client.post("/api/enrollment-tokens", json={"name": "Private Agent"})
        hello = {
            "v": 2,
            "type": "hello",
            "enrollment_token": created.json()["secret"],
            "name": "Private Agent",
            "description": "",
            "profiles": SHELL_DECLARATIONS,
            "version": AGENT_VERSION,
        }
        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(hello)
            websocket.receive_json()
        self.client.post("/api/auth/logout")
        self.register("other@example.com")
        self.assertEqual(self.client.get("/api/agents").json()["agents"], [])

    def test_user_can_build_and_download_python_agent(self) -> None:
        self.register()
        created = self.client.post(
            "/api/agent-bundles",
            json={
                "name": "Built Agent",
                "description": "从工作台组装",
                "runtime": "python",
                "profiles": ["shell.v1"],
            },
        )
        self.assertEqual(created.status_code, 201, created.text)
        payload = created.json()
        self.assertTrue(payload["secret"].startswith("enroll_"))
        self.assertIn("python run.py", payload["command"])
        self.assertIn("/install-agent.sh", payload["install_command"])
        self.assertIn(payload["bundle"]["id"], payload["install_command"])
        self.assertNotIn(payload["secret"], payload["install_command"])
        token_prefix = payload["secret"][:14]
        token_record = next(
            item
            for item in self.client.get("/api/enrollment-tokens").json()["tokens"]
            if item["prefix"] == token_prefix
        )
        self.assertEqual(token_record["expires_at"], payload["bundle"]["expires_at"])

        download = self.client.get(payload["bundle"]["download_url"])
        self.assertEqual(download.status_code, 200, download.text)
        self.assertEqual(download.headers["content-type"], "application/zip")
        with zipfile.ZipFile(BytesIO(download.content)) as archive:
            self.assertTrue(any(name.endswith("/remote_agent/profiles/shell_v1/profile.py") for name in archive.namelist()))
            combined = b"\n".join(archive.read(name) for name in archive.namelist())
        self.assertNotIn(payload["secret"].encode(), combined)

        self.client.post("/api/auth/logout")
        unauthenticated = self.client.get(
            f"/api/agent-bundles/{payload['bundle']['id']}/install-download"
        )
        self.assertEqual(unauthenticated.status_code, 404)
        wrong = self.client.get(
            f"/api/agent-bundles/{payload['bundle']['id']}/install-download",
            headers={"Authorization": "Bearer enroll_wrong"},
        )
        self.assertEqual(wrong.status_code, 404)
        install_download = self.client.get(
            f"/api/agent-bundles/{payload['bundle']['id']}/install-download",
            headers={"Authorization": f"Bearer {payload['secret']}"},
        )
        self.assertEqual(install_download.status_code, 200, install_download.text)
        self.assertEqual(install_download.headers["cache-control"], "no-store")
        self.assertEqual(install_download.headers["content-type"], "application/zip")

        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(
                {
                    "v": 2,
                    "type": "hello",
                    "enrollment_token": payload["secret"],
                    "name": "Built Agent",
                    "description": "从工作台组装",
                    "profiles": SHELL_DECLARATIONS,
                    "version": AGENT_VERSION,
                }
            )
            self.assertEqual(websocket.receive_json()["type"], "registered")
        consumed = self.client.get(
            f"/api/agent-bundles/{payload['bundle']['id']}/install-download",
            headers={"Authorization": f"Bearer {payload['secret']}"},
        )
        self.assertEqual(consumed.status_code, 404)

    def test_registered_agent_can_download_its_own_latest_runtime(self) -> None:
        self.register()
        created = self.client.post("/api/enrollment-tokens", json={"name": "Managed Linux"})
        hello = {
            "v": 2,
            "type": "hello",
            "enrollment_token": created.json()["secret"],
            "name": "Managed Linux",
            "description": "upgrade target",
            "profiles": SHELL_DECLARATIONS,
            "version": AGENT_VERSION,
        }
        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(hello)
            registered = websocket.receive_json()
            agent_id = registered["agent_id"]
            credential = registered["credential"]

            status = self.client.get(
                f"/api/agents/{agent_id}/self-status",
                headers={"Authorization": f"Bearer {credential}"},
            )
            self.assertEqual(status.status_code, 200, status.text)
            self.assertTrue(status.json()["online"])
            self.assertEqual(status.json()["lifecycle_status"], "current")

            runtime = self.client.get(
                f"/api/agents/{agent_id}/runtime-download",
                headers={"Authorization": f"Bearer {credential}"},
            )
            self.assertEqual(runtime.status_code, 200, runtime.text)
            self.assertEqual(runtime.headers["cache-control"], "no-store")
            with zipfile.ZipFile(BytesIO(runtime.content)) as archive:
                manifest_name = next(
                    name for name in archive.namelist() if name.endswith("/remote_agent/manifest.json")
                )
                manifest = json.loads(archive.read(manifest_name))
            self.assertEqual(manifest["profiles"], ["shell.v1"])
            self.assertEqual(manifest["agent"]["name"], "Managed Linux")

        denied = self.client.get(
            f"/api/agents/{agent_id}/runtime-download",
            headers={"Authorization": "Bearer agent_wrong"},
        )
        self.assertEqual(denied.status_code, 404)
        enrollment_denied = self.client.get(
            f"/api/agents/{agent_id}/runtime-download",
            headers={"Authorization": f"Bearer {created.json()['secret']}"},
        )
        self.assertEqual(enrollment_denied.status_code, 404)

    def test_agent_lifecycle_distinguishes_upgrade_from_reenrollment(self) -> None:
        self.register()
        created = self.client.post("/api/enrollment-tokens", json={"name": "Lifecycle"})
        hello = {
            "v": 2,
            "type": "hello",
            "enrollment_token": created.json()["secret"],
            "name": "Lifecycle",
            "description": "",
            "profiles": SHELL_DECLARATIONS,
            "version": AGENT_VERSION,
        }
        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(hello)
            agent_id = websocket.receive_json()["agent_id"]

        database = self.client.app.state.database
        incompatible = dict(AGENT_VERSION)
        incompatible["protocol_version"] = 1
        incompatible["build_id"] = "old-protocol"
        database.update_agent_runtime(agent_id, SHELL_DECLARATIONS, incompatible)
        agent = self.client.get(f"/api/agents/{agent_id}").json()["agent"]
        self.assertEqual(agent["version_status"], "incompatible")
        self.assertEqual(agent["lifecycle_status"], "upgrade_available")
        self.assertFalse(agent["requires_reenrollment"])
        self.assertEqual(
            agent["managed_upgrade_command"],
            "sudo remote-runtime-agent-upgrade",
        )

        database.update_agent_runtime(agent_id, [], incompatible)
        legacy = self.client.get(f"/api/agents/{agent_id}").json()["agent"]
        self.assertTrue(legacy["requires_reenrollment"])
        self.assertEqual(legacy["lifecycle_status"], "reenroll_required")

    def test_bundle_download_is_owner_scoped(self) -> None:
        self.register()
        created = self.client.post(
            "/api/agent-bundles",
            json={"name": "Private Bundle", "runtime": "python", "profiles": ["shell.v1"]},
        ).json()
        self.client.post("/api/auth/logout")
        self.register("bundle-other@example.com")
        response = self.client.get(created["bundle"]["download_url"])
        self.assertEqual(response.status_code, 404)

    def test_builder_rejects_unknown_profile(self) -> None:
        self.register()
        response = self.client.post(
            "/api/agent-bundles",
            json={"name": "Invalid Bundle", "runtime": "python", "profiles": ["unknown.v1"]},
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("不支持的 Profile", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
