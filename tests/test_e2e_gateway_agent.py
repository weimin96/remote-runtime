from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

import httpx


class GatewayAgentEndToEndTests(unittest.TestCase):
    @staticmethod
    def _free_port() -> int:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            return listener.getsockname()[1]

    @staticmethod
    def _stop(process: subprocess.Popen[str] | None) -> None:
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()

    @staticmethod
    def _wait_http(client: httpx.Client, url: str, process: subprocess.Popen[str]) -> None:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if process.poll() is not None:
                stdout, stderr = process.communicate()
                raise AssertionError(f"Gateway exited early\nstdout:\n{stdout}\nstderr:\n{stderr}")
            try:
                if client.get(url).status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.1)
        raise AssertionError("Gateway did not become healthy within 20 seconds")

    @staticmethod
    def _mcp_call(
        client: httpx.Client,
        base_url: str,
        secret: str,
        request_id: int,
        method: str,
        params: dict,
    ) -> dict:
        response = client.post(
            f"{base_url}/mcp/",
            headers={
                "Authorization": f"Bearer {secret}",
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
            json={"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
            timeout=30,
        )
        if response.status_code != 200:
            raise AssertionError(f"MCP {method} failed: {response.status_code} {response.text}")
        payload = response.json()
        if "error" in payload:
            raise AssertionError(f"MCP {method} returned error: {payload['error']}")
        return payload["result"]

    def test_built_agent_connects_and_serves_real_mcp_shell_and_workspace_calls(self) -> None:
        gateway: subprocess.Popen[str] | None = None
        agent: subprocess.Popen[str] | None = None
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            port = self._free_port()
            base_url = f"http://127.0.0.1:{port}"
            environment = os.environ.copy()
            environment.update(
                {
                    "GATEWAY_HOST": "127.0.0.1",
                    "GATEWAY_PORT": str(port),
                    "GATEWAY_PUBLIC_URL": base_url,
                    "GATEWAY_DATA_DIR": str(root / "data"),
                    "GATEWAY_DATABASE": str(root / "data" / "gateway.db"),
                    "GATEWAY_SECURE_COOKIES": "false",
                    "PYTHONUNBUFFERED": "1",
                }
            )
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
            gateway = subprocess.Popen(
                [sys.executable, "-m", "gateway"],
                cwd=Path(__file__).resolve().parents[1],
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creationflags,
            )
            try:
                with httpx.Client() as client:
                    self._wait_http(client, f"{base_url}/api/health", gateway)
                    registered = client.post(
                        f"{base_url}/api/auth/register",
                        json={
                            "email": "e2e@example.com",
                            "password": "correct horse battery staple",
                        },
                    )
                    self.assertEqual(registered.status_code, 201, registered.text)
                    mcp_secret = client.post(
                        f"{base_url}/api/mcp-keys", json={"name": "E2E"}
                    ).json()["secret"]
                    bundle_response = client.post(
                        f"{base_url}/api/agent-bundles",
                        json={
                            "name": "E2E Agent",
                            "description": "real process chain",
                            "runtime": "python",
                            "profiles": ["shell.v1", "workspace.v1"],
                        },
                    )
                    self.assertEqual(bundle_response.status_code, 201, bundle_response.text)
                    bundle = bundle_response.json()
                    install_download_url = (
                        f"{base_url}/api/agent-bundles/"
                        f"{bundle['bundle']['id']}/install-download"
                    )
                    archive_response = client.get(
                        install_download_url,
                        headers={"Authorization": f"Bearer {bundle['secret']}"},
                    )
                    self.assertEqual(archive_response.status_code, 200, archive_response.text)
                    archive_path = root / "agent.zip"
                    archive_path.write_bytes(archive_response.content)
                    extracted = root / "agent"
                    with zipfile.ZipFile(archive_path) as archive:
                        archive.extractall(extracted)
                    launcher = next(extracted.rglob("run.py"))
                    workspace = root / "workspace"
                    workspace.mkdir()
                    token_file = root / "enrollment-token"
                    token_file.write_text(bundle["secret"] + "\n", encoding="utf-8")
                    config_path = root / "device-config.json"

                    enrollment = subprocess.run(
                        [
                            sys.executable,
                            str(launcher),
                            "--gateway",
                            f"ws://127.0.0.1:{port}/ws/agent",
                            "--token-file",
                            str(token_file),
                            "--config",
                            str(config_path),
                            "--workdir",
                            str(workspace),
                            "--enroll-only",
                        ],
                        cwd=launcher.parent,
                        env=environment,
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        timeout=20,
                    )
                    self.assertEqual(
                        enrollment.returncode,
                        0,
                        f"enroll-only failed\nstdout:\n{enrollment.stdout}\nstderr:\n{enrollment.stderr}",
                    )
                    self.assertFalse(token_file.exists())
                    self.assertTrue(config_path.is_file())
                    consumed_download = client.get(
                        install_download_url,
                        headers={"Authorization": f"Bearer {bundle['secret']}"},
                    )
                    self.assertEqual(consumed_download.status_code, 404)

                    agent = subprocess.Popen(
                        [
                            sys.executable,
                            str(launcher),
                            "--config",
                            str(config_path),
                            "--workdir",
                            str(workspace),
                        ],
                        cwd=launcher.parent,
                        env=environment,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        creationflags=creationflags,
                    )

                    deadline = time.monotonic() + 20
                    agents = []
                    while time.monotonic() < deadline:
                        if agent.poll() is not None:
                            stdout, stderr = agent.communicate()
                            self.fail(f"Agent exited early\nstdout:\n{stdout}\nstderr:\n{stderr}")
                        agents = client.get(f"{base_url}/api/agents").json()["agents"]
                        if agents and agents[0]["online"]:
                            break
                        time.sleep(0.1)
                    self.assertTrue(agents and agents[0]["online"], "Agent did not connect")
                    agent_id = agents[0]["id"]
                    device_config = json.loads(config_path.read_text(encoding="utf-8"))
                    device_headers = {
                        "Authorization": f"Bearer {device_config['credential']}"
                    }
                    self_status = client.get(
                        f"{base_url}/api/agents/{agent_id}/self-status",
                        headers=device_headers,
                    )
                    self.assertEqual(self_status.status_code, 200, self_status.text)
                    self.assertTrue(self_status.json()["online"])
                    self.assertEqual(self_status.json()["version_status"], "current")

                    runtime_download = client.get(
                        f"{base_url}/api/agents/{agent_id}/runtime-download",
                        headers=device_headers,
                    )
                    self.assertEqual(runtime_download.status_code, 200, runtime_download.text)
                    with zipfile.ZipFile(BytesIO(runtime_download.content)) as runtime_archive:
                        runtime_manifest_name = next(
                            name
                            for name in runtime_archive.namelist()
                            if name.endswith("/remote_agent/manifest.json")
                        )
                        runtime_manifest = json.loads(
                            runtime_archive.read(runtime_manifest_name)
                        )
                    self.assertEqual(
                        runtime_manifest["profiles"],
                        ["shell.v1", "workspace.v1"],
                    )

                    initialized = self._mcp_call(
                        client,
                        base_url,
                        mcp_secret,
                        1,
                        "initialize",
                        {
                            "protocolVersion": "2025-11-25",
                            "capabilities": {},
                            "clientInfo": {"name": "e2e", "version": "1"},
                        },
                    )
                    self.assertEqual(initialized["serverInfo"]["name"], "Remote Runtime")
                    tools = self._mcp_call(client, base_url, mcp_secret, 2, "tools/list", {})
                    self.assertIn("remote_exec", [tool["name"] for tool in tools["tools"]])

                    shell = self._mcp_call(
                        client,
                        base_url,
                        mcp_secret,
                        3,
                        "tools/call",
                        {
                            "name": "remote_exec",
                            "arguments": {
                                "agent_id": agent_id,
                                "command": 'python -c "print(\'real-e2e\')"',
                                "timeout": 20,
                            },
                        },
                    )["structuredContent"]
                    self.assertEqual(shell["exit_code"], 0)
                    self.assertIn("real-e2e", shell["stdout"])

                    written = self._mcp_call(
                        client,
                        base_url,
                        mcp_secret,
                        4,
                        "tools/call",
                        {
                            "name": "remote_write_file",
                            "arguments": {
                                "agent_id": agent_id,
                                "path": "verified.txt",
                                "content": "gateway-agent-mcp",
                                "expected_sha256": None,
                            },
                        },
                    )["structuredContent"]
                    self.assertTrue(written["changed"])
                    read = self._mcp_call(
                        client,
                        base_url,
                        mcp_secret,
                        5,
                        "tools/call",
                        {
                            "name": "remote_read_file",
                            "arguments": {"agent_id": agent_id, "path": "verified.txt"},
                        },
                    )["structuredContent"]
                    self.assertEqual(read["content"], "gateway-agent-mcp")
                    self.assertEqual((workspace / "verified.txt").read_text(), "gateway-agent-mcp")
            finally:
                self._stop(agent)
                self._stop(gateway)


if __name__ == "__main__":
    unittest.main()
