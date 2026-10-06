from __future__ import annotations

import base64
import hashlib
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from gateway.agent_protocol import CURRENT_AGENT_VERSION, CURRENT_CORE_VERSION
from gateway.app import create_app
from gateway.config import Settings
from gateway.database import Database
from gateway.profiles import profile_mcp_tools, public_profile_catalog
from gateway.security import hash_password, issue_token
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


class McpApiTests(unittest.TestCase):
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
        self.client.post(
            "/api/auth/register",
            json={"email": "mcp@example.com", "password": "correct horse battery staple"},
        )
        created = self.client.post("/api/mcp-keys", json={"name": "MCP Test"})
        self.secret = created.json()["secret"]
        self.base_headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.tempdir.cleanup()

    def test_mcp_rejects_missing_bearer_key(self) -> None:
        response = self.client.post(
            "/mcp/",
            headers=self.base_headers,
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn(
            "http://testserver/.well-known/oauth-protected-resource/mcp/",
            response.headers.get("www-authenticate", ""),
        )

    def test_authenticated_mcp_lists_fixed_tools(self) -> None:
        headers = {**self.base_headers, "Authorization": f"Bearer {self.secret}"}
        initialized = self.client.post(
            "/mcp/",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
        )
        self.assertEqual(initialized.status_code, 200, initialized.text)

        listed = self.client.post(
            "/mcp/",
            headers=headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        listed_tools = listed.json()["result"]["tools"]
        names = [tool["name"] for tool in listed_tools]
        self.assertEqual(
            names,
            [
                "list_agents",
                "get_agent_capabilities",
                "remote_exec",
                "remote_read_file",
                "remote_write_file",
                "remote_edit_file",
            ],
        )
        descriptions = {tool["name"]: tool["description"] for tool in listed_tools}
        schemas = {tool["name"]: tool["inputSchema"] for tool in listed_tools}
        self.assertIn("get_agent_capabilities", descriptions["remote_exec"])
        self.assertIn("shell.v1", descriptions["remote_exec"])
        self.assertIn("mcp_tool", descriptions["remote_exec"])
        self.assertIn("必须先调用", descriptions["get_agent_capabilities"])
        self.assertIn("workspace.v1", descriptions["remote_read_file"])
        self.assertIn("expected_sha256", descriptions["remote_edit_file"])
        write_schema = schemas["remote_write_file"]
        self.assertIn("expected_sha256", write_schema["required"])
        expected_schema = write_schema["properties"]["expected_sha256"]
        self.assertEqual(
            {item.get("type") for item in expected_schema["anyOf"]},
            {"string", "null"},
        )
        mappings = [
            action.get("mcp_tool")
            for profile in public_profile_catalog()
            for action in profile["actions"]
        ]
        self.assertTrue(mappings)
        self.assertTrue(all(isinstance(mapping, str) and mapping for mapping in mappings))
        self.assertEqual(set(mappings), profile_mcp_tools())
        self.assertTrue(set(mappings).issubset(names))

    def test_capability_contract_names_its_mcp_tool(self) -> None:
        enrollment = self.client.post(
            "/api/enrollment-tokens", json={"name": "Capability Agent"}
        ).json()["secret"]
        hello = {
            "v": 2,
            "type": "hello",
            "enrollment_token": enrollment,
            "name": "Capability Agent",
            "description": "",
            "profiles": SHELL_DECLARATIONS,
            "version": {
                "agent_version": CURRENT_AGENT_VERSION,
                "core_version": CURRENT_CORE_VERSION,
                "protocol_version": 2,
                "build_id": "mcp-capability-test",
            },
        }
        headers = {**self.base_headers, "Authorization": f"Bearer {self.secret}"}
        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(hello)
            agent_id = websocket.receive_json()["agent_id"]
            response = self.client.post(
                "/mcp/",
                headers=headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "get_agent_capabilities",
                        "arguments": {"agent_id": agent_id},
                    },
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        profile = response.json()["result"]["structuredContent"]["profiles"][0]
        self.assertEqual(profile["id"], "shell.v1")
        self.assertEqual(profile["actions"][0]["mcp_tool"], "remote_exec")
        self.assertEqual(
            response.json()["result"]["structuredContent"]["gateway_limits"][
                "max_concurrent_requests_per_agent"
            ],
            MAX_CONCURRENT_REQUESTS_PER_AGENT,
        )
        self.assertEqual(
            response.json()["result"]["structuredContent"]["agent"]["shell_policy"]["mode"],
            "off",
        )

    def test_standard_shell_policy_blocks_before_agent_dispatch(self) -> None:
        enrollment = self.client.post(
            "/api/enrollment-tokens", json={"name": "Protected Agent"}
        ).json()["secret"]
        hello = {
            "v": 2,
            "type": "hello",
            "enrollment_token": enrollment,
            "name": "Protected Agent",
            "description": "",
            "profiles": SHELL_DECLARATIONS,
            "version": {
                "agent_version": CURRENT_AGENT_VERSION,
                "core_version": CURRENT_CORE_VERSION,
                "protocol_version": 2,
                "build_id": "mcp-policy-test",
            },
        }
        headers = {**self.base_headers, "Authorization": f"Bearer {self.secret}"}
        with self.client.websocket_connect("/ws/agent") as websocket:
            websocket.send_json(hello)
            agent_id = websocket.receive_json()["agent_id"]
            configured = self.client.patch(
                f"/api/agents/{agent_id}/shell-policy", json={"mode": "standard"}
            )
            self.assertEqual(configured.status_code, 200, configured.text)
            response = self.client.post(
                "/mcp/",
                headers=headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "remote_exec",
                        "arguments": {
                            "agent_id": agent_id,
                            "command": "Format-Volume -DriveLetter C",
                        },
                    },
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()["result"]
        self.assertTrue(result["isError"])
        self.assertIn("command_blocked [disk_management]", result["content"][0]["text"])


class LocalMcpApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        settings = Settings(
            host="127.0.0.1",
            port=8000,
            public_url="http://testserver",
            data_dir=root / "data",
            database_path=root / "test.db",
            session_days=1,
            enrollment_minutes=30,
            max_command_timeout=60,
            secure_cookies=False,
            local_workdir=root / "workspace",
        )
        settings.local_workdir.mkdir()
        database = Database(settings.database_path)
        database.initialize()
        self.owner = database.create_owner(
            "local@example.com",
            hash_password("correct horse battery staple"),
        )
        self.client_context = TestClient(create_app(settings))
        self.client = self.client_context.__enter__()
        logged_in = self.client.post(
            "/api/auth/login",
            json={"email": "local@example.com", "password": "correct horse battery staple"},
        )
        self.assertEqual(logged_in.status_code, 200, logged_in.text)
        self.headers = self._oauth_headers()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.tempdir.cleanup()

    def _oauth_headers(self) -> dict[str, str]:
        registration = self.client.post(
            "/oauth/register",
            json={
                "redirect_uris": ["https://chatgpt.com/connector_platform_oauth_redirect"],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "scope": "gateway:use offline_access",
                "client_name": "Test ChatGPT",
            },
        )
        self.assertEqual(registration.status_code, 201, registration.text)
        client_id = registration.json()["client_id"]
        verifier = "setup-verifier-with-enough-entropy-1234567890"
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode("ascii")).digest()
        ).rstrip(b"=").decode("ascii")
        auth_params = {
            "client_id": client_id,
            "redirect_uri": "https://chatgpt.com/connector_platform_oauth_redirect",
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "setup-state",
            "scope": "gateway:use offline_access",
            "resource": "http://testserver/mcp/",
        }
        authorize = self.client.get("/oauth/authorize", params=auth_params)
        self.assertEqual(authorize.status_code, 200, authorize.text)
        csrf_token = self.client.cookies.get("remote_gateway_oauth_csrf")
        self.assertTrue(csrf_token)
        approval = self.client.post(
            "/oauth/authorize",
            data={
                **auth_params,
                "decision": "allow",
                "use_session": "1",
                "csrf_token": csrf_token,
            },
            follow_redirects=False,
        )
        self.assertEqual(approval.status_code, 302, approval.text)
        code = parse_qs(urlparse(approval.headers["location"]).query)["code"][0]
        exchanged = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": "https://chatgpt.com/connector_platform_oauth_redirect",
                "resource": "http://testserver/mcp/",
            },
        )
        self.assertEqual(exchanged.status_code, 200, exchanged.text)
        return {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {exchanged.json()['access_token']}",
        }

    def test_local_mode_closes_public_registration_and_remote_admin_api(self) -> None:
        self.assertEqual(
            self.client.post(
                "/api/auth/register",
                json={"email": "attacker@example.com", "password": "correct horse battery staple"},
            ).status_code,
            404,
        )
        self.assertEqual(self.client.get("/api/agents").status_code, 404)
        self.assertEqual(self.client.get("/api/mcp-keys").status_code, 404)
        self.assertEqual(self.client.get("/api/docs").status_code, 404)

    def test_local_mode_rejects_legacy_mcp_key(self) -> None:
        legacy = issue_token("mcp")
        self.client.app.state.database.create_mcp_key(
            self.owner["id"],
            "legacy local key",
            legacy.prefix,
            legacy.digest,
        )
        response = self.client.post(
            "/mcp/",
            headers={
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {legacy.value}",
            },
            json={"jsonrpc": "2.0", "id": 99, "method": "tools/list", "params": {}},
        )
        self.assertEqual(response.status_code, 401, response.text)

    def test_local_login_is_rate_limited(self) -> None:
        for _ in range(8):
            response = self.client.post(
                "/api/auth/login",
                json={"email": "nobody@example.com", "password": "incorrect password value"},
            )
            self.assertEqual(response.status_code, 401, response.text)
        limited = self.client.post(
            "/api/auth/login",
            json={"email": "nobody@example.com", "password": "incorrect password value"},
        )
        self.assertEqual(limited.status_code, 429, limited.text)
        self.assertIn("Retry-After", limited.headers)

    def test_local_mode_exposes_only_codex_style_tools(self) -> None:
        listed = self.client.post(
            "/mcp/",
            headers=self.headers,
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        tools = listed.json()["result"]["tools"]
        names = [tool["name"] for tool in tools]
        self.assertEqual(names, ["exec_command", "write_stdin", "apply_patch"])
        schemas = {tool["name"]: tool["inputSchema"] for tool in tools}
        exec_properties = schemas["exec_command"]["properties"]
        stdin_properties = schemas["write_stdin"]["properties"]
        patch_properties = schemas["apply_patch"]["properties"]
        self.assertIn("tty", exec_properties)
        self.assertIn("persistent", exec_properties)
        self.assertIn("columns", exec_properties)
        self.assertIn("rows", exec_properties)
        self.assertIn("columns", stdin_properties)
        self.assertIn("rows", stdin_properties)
        self.assertIn("cwd", patch_properties)
        annotations = {tool["name"]: tool["annotations"] for tool in tools}
        self.assertTrue(annotations["exec_command"]["destructiveHint"])
        self.assertTrue(annotations["exec_command"]["openWorldHint"])
        self.assertTrue(annotations["apply_patch"]["destructiveHint"])
        self.assertFalse(annotations["apply_patch"]["openWorldHint"])

    def test_local_exec_command_runs_in_configured_workspace(self) -> None:
        response = self.client.post(
            "/mcp/",
            headers=self.headers,
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "exec_command",
                    "arguments": {"cmd": "pwd"},
                },
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        content = response.json()["result"]["structuredContent"]
        self.assertEqual(content["exit_code"], 0)
        self.assertIn(str(Path(self.tempdir.name) / "workspace"), content["output"])
        audit = self.client.get("/api/audit-logs").json()["logs"]
        self.assertEqual(audit[0]["tool_name"], "exec_command")
        self.assertEqual(audit[0]["action_summary"], "pwd")
        self.assertEqual(audit[0]["success"], 1)

    def test_local_audit_redacts_common_secrets(self) -> None:
        response = self.client.post(
            "/mcp/",
            headers=self.headers,
            json={
                "jsonrpc": "2.0",
                "id": 22,
                "method": "tools/call",
                "params": {
                    "name": "exec_command",
                    "arguments": {"cmd": "TOKEN=super-secret printf ok"},
                },
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        audit = self.client.get("/api/audit-logs").json()["logs"]
        self.assertIn("TOKEN=<redacted>", audit[0]["action_summary"])
        self.assertNotIn("super-secret", audit[0]["action_summary"])

    def test_oauth_authorization_code_pkce_and_refresh_flow(self) -> None:
        metadata = self.client.get("/.well-known/oauth-authorization-server")
        self.assertEqual(metadata.status_code, 200, metadata.text)
        self.assertEqual(metadata.json()["code_challenge_methods_supported"], ["S256"])
        self.assertEqual(metadata.json()["token_endpoint_auth_methods_supported"], ["none"])

        resource_metadata = self.client.get("/.well-known/oauth-protected-resource/mcp/")
        self.assertEqual(resource_metadata.status_code, 200, resource_metadata.text)
        self.assertEqual(resource_metadata.json()["resource"], "http://testserver/mcp/")

        registration = self.client.post(
            "/oauth/register",
            json={
                "redirect_uris": ["https://chatgpt.com/connector_platform_oauth_redirect"],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "scope": "gateway:use offline_access",
                "client_name": "ChatGPT",
            },
        )
        self.assertEqual(registration.status_code, 201, registration.text)
        client_id = registration.json()["client_id"]

        verifier = "test-verifier-with-enough-entropy-1234567890"
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode("ascii")).digest()
        ).rstrip(b"=").decode("ascii")
        auth_params = {
            "client_id": client_id,
            "redirect_uri": "https://chatgpt.com/connector_platform_oauth_redirect",
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "state-123",
            "scope": "gateway:use offline_access",
            "resource": "http://testserver/mcp/",
        }
        authorize = self.client.get("/oauth/authorize", params=auth_params)
        self.assertEqual(authorize.status_code, 200, authorize.text)
        self.assertIn("授权 MCP 客户端", authorize.text)
        self.assertIn("ChatGPT", authorize.text)
        self.assertIn("connector_platform_oauth_redirect", authorize.text)
        self.assertIn(
            "form-action 'self' https://chatgpt.com",
            authorize.headers.get("content-security-policy", ""),
        )
        index_response = self.client.get("/")
        self.assertIn(
            "form-action 'self'",
            index_response.headers.get("content-security-policy", ""),
        )
        self.assertNotIn(
            "form-action 'self' https://chatgpt.com",
            index_response.headers.get("content-security-policy", ""),
        )
        csrf_token = self.client.cookies.get("remote_gateway_oauth_csrf")
        self.assertTrue(csrf_token)

        approval = self.client.post(
            "/oauth/authorize",
            data={
                **auth_params,
                "decision": "allow",
                "use_session": "1",
                "csrf_token": csrf_token,
            },
            follow_redirects=False,
        )
        self.assertEqual(approval.status_code, 302, approval.text)
        callback = urlparse(approval.headers["location"])
        callback_params = parse_qs(callback.query)
        self.assertEqual(callback_params["state"], ["state-123"])
        self.assertEqual(callback_params["iss"], ["http://testserver"])
        code = callback_params["code"][0]

        exchanged = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": "https://chatgpt.com/connector_platform_oauth_redirect",
                "resource": "http://testserver/mcp/",
            },
        )
        self.assertEqual(exchanged.status_code, 200, exchanged.text)
        access_token = exchanged.json()["access_token"]
        refresh_token = exchanged.json()["refresh_token"]

        listed = self.client.post(
            "/mcp/",
            headers={
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {access_token}",
            },
            json={"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}},
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(
            [tool["name"] for tool in listed.json()["result"]["tools"]],
            ["exec_command", "write_stdin", "apply_patch"],
        )

        refreshed = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": refresh_token,
                "resource": "http://testserver/mcp/",
            },
        )
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        refreshed_access_token = refreshed.json()["access_token"]
        refreshed_refresh_token = refreshed.json()["refresh_token"]
        self.assertNotEqual(refreshed_access_token, access_token)
        self.assertNotEqual(refreshed_refresh_token, refresh_token)

        replay = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": refresh_token,
                "resource": "http://testserver/mcp/",
            },
        )
        self.assertEqual(replay.status_code, 400, replay.text)
        self.assertEqual(replay.json()["error"], "invalid_grant")

        revoked_access = self.client.post(
            "/mcp/",
            headers={
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {refreshed_access_token}",
            },
            json={"jsonrpc": "2.0", "id": 4, "method": "tools/list", "params": {}},
        )
        self.assertEqual(revoked_access.status_code, 401, revoked_access.text)

        revoked_refresh = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": refreshed_refresh_token,
                "resource": "http://testserver/mcp/",
            },
        )
        self.assertEqual(revoked_refresh.status_code, 400, revoked_refresh.text)
        self.assertEqual(revoked_refresh.json()["error"], "invalid_grant")

    def test_oauth_wrong_pkce_does_not_consume_authorization_code(self) -> None:
        registration = self.client.post(
            "/oauth/register",
            json={
                "redirect_uris": ["https://chatgpt.com/connector_platform_oauth_redirect"],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "scope": "gateway:use offline_access",
            },
        )
        client_id = registration.json()["client_id"]
        verifier = "correct-verifier-with-enough-entropy-1234567890"
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode("ascii")).digest()
        ).rstrip(b"=").decode("ascii")
        auth_params = {
            "client_id": client_id,
            "redirect_uri": "https://chatgpt.com/connector_platform_oauth_redirect",
            "response_type": "code",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "pkce-state",
            "scope": "gateway:use offline_access",
            "resource": "http://testserver/mcp/",
        }
        authorize = self.client.get("/oauth/authorize", params=auth_params)
        self.assertEqual(authorize.status_code, 200, authorize.text)
        csrf_token = self.client.cookies.get("remote_gateway_oauth_csrf")
        self.assertTrue(csrf_token)
        approval = self.client.post(
            "/oauth/authorize",
            data={
                **auth_params,
                "decision": "allow",
                "use_session": "1",
                "csrf_token": csrf_token,
            },
            follow_redirects=False,
        )
        code = parse_qs(urlparse(approval.headers["location"]).query)["code"][0]

        wrong = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "code_verifier": "wrong-verifier-with-enough-entropy-1234567890",
                "redirect_uri": "https://chatgpt.com/connector_platform_oauth_redirect",
                "resource": "http://testserver/mcp/",
            },
        )
        self.assertEqual(wrong.status_code, 400, wrong.text)
        self.assertEqual(wrong.json()["error"], "invalid_grant")

        correct = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": "https://chatgpt.com/connector_platform_oauth_redirect",
                "resource": "http://testserver/mcp/",
            },
        )
        self.assertEqual(correct.status_code, 200, correct.text)

    def test_oauth_authorize_post_requires_csrf_token(self) -> None:
        registration = self.client.post(
            "/oauth/register",
            json={
                "redirect_uris": ["https://chatgpt.com/connector_platform_oauth_redirect"],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "scope": "gateway:use offline_access",
            },
        )
        client_id = registration.json()["client_id"]
        verifier = "csrf-verifier-with-enough-entropy-123456789012"
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode("ascii")).digest()
        ).rstrip(b"=").decode("ascii")
        response = self.client.post(
            "/oauth/authorize",
            data={
                "client_id": client_id,
                "redirect_uri": "https://chatgpt.com/connector_platform_oauth_redirect",
                "response_type": "code",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": "csrf-state",
                "scope": "gateway:use offline_access",
                "resource": "http://testserver/mcp/",
                "decision": "allow",
            },
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("CSRF", response.text)


if __name__ == "__main__":
    unittest.main()
