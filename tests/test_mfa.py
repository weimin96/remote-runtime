from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import Settings
from gateway.database import Database
from gateway.mfa import provision_owner_mfa, verify_owner_mfa_code
from gateway.security import hash_password, totp_code


class TotpTests(unittest.TestCase):
    def test_totp_matches_rfc6238_sha1_vector(self) -> None:
        secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        self.assertEqual(totp_code(secret, at_time=59, digits=8), "94287082")


class LocalMfaFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        workspace = root / "workspace"
        workspace.mkdir()
        self.settings = Settings(
            host="127.0.0.1",
            port=8000,
            public_url="http://testserver",
            data_dir=root / "data",
            database_path=root / "data" / "gateway.db",
            session_days=1,
            enrollment_minutes=30,
            max_command_timeout=60,
            secure_cookies=False,
            local_workdir=workspace,
        )
        self.db = Database(self.settings.database_path)
        self.db.initialize()
        self.owner = self.db.create_owner(
            "owner@example.com",
            hash_password("correct horse battery staple"),
        )
        self.secret, self.recovery_codes, _ = provision_owner_mfa(
            self.db,
            self.owner["id"],
            self.owner["email"],
        )
        self.client_context = TestClient(create_app(self.settings))
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.tempdir.cleanup()

    def login(self, mfa_code: str) -> int:
        response = self.client.post(
            "/api/auth/login",
            json={
                "email": "owner@example.com",
                "password": "correct horse battery staple",
                "mfa_code": mfa_code,
            },
        )
        return response.status_code

    def test_local_login_requires_totp(self) -> None:
        session = self.client.get("/api/session").json()
        self.assertTrue(session["mfa_required"])
        self.assertEqual(self.login(""), 401)
        self.assertEqual(self.login("000000"), 401)
        self.assertEqual(self.login(totp_code(self.secret)), 200)

    def test_recovery_code_is_single_use(self) -> None:
        recovery_code = self.recovery_codes[0]
        self.assertEqual(self.login(recovery_code), 200)
        self.client.post("/api/auth/logout")
        self.assertEqual(self.login(recovery_code), 401)

    def test_direct_oauth_password_authorization_requires_mfa(self) -> None:
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
        client_id = registration.json()["client_id"]
        auth_params = {
            "client_id": client_id,
            "redirect_uri": "https://chatgpt.com/connector_platform_oauth_redirect",
            "response_type": "code",
            "code_challenge": "A" * 43,
            "code_challenge_method": "S256",
            "state": "mfa-state",
            "scope": "gateway:use offline_access",
            "resource": "http://testserver/mcp/",
        }
        page = self.client.get("/oauth/authorize", params=auth_params)
        self.assertEqual(page.status_code, 200, page.text)
        self.assertIn("验证码", page.text)
        csrf = self.client.cookies.get("remote_gateway_oauth_csrf")
        self.assertTrue(csrf)

        denied = self.client.post(
            "/oauth/authorize",
            data={
                **auth_params,
                "decision": "allow",
                "csrf_token": csrf,
                "email": "owner@example.com",
                "password": "correct horse battery staple",
                "mfa_code": "000000",
            },
            follow_redirects=False,
        )
        self.assertEqual(denied.status_code, 401, denied.text)

        allowed = self.client.post(
            "/oauth/authorize",
            data={
                **auth_params,
                "decision": "allow",
                "csrf_token": csrf,
                "email": "owner@example.com",
                "password": "correct horse battery staple",
                "mfa_code": totp_code(self.secret),
            },
            follow_redirects=False,
        )
        self.assertEqual(allowed.status_code, 302, allowed.text)
        callback = parse_qs(urlparse(allowed.headers["location"]).query)
        self.assertIn("code", callback)

    def test_local_dcr_rejects_non_chatgpt_redirect(self) -> None:
        response = self.client.post(
            "/oauth/register",
            json={
                "redirect_uris": ["https://attacker.example/callback"],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "scope": "gateway:use offline_access",
                "client_name": "Not ChatGPT",
            },
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["error"], "invalid_client_metadata")

    def test_provisioning_rotates_recovery_codes(self) -> None:
        code = self.recovery_codes[0]
        self.assertTrue(verify_owner_mfa_code(self.db, self.owner["id"], code))
        _, new_codes, _ = provision_owner_mfa(self.db, self.owner["id"], self.owner["email"])
        self.assertFalse(verify_owner_mfa_code(self.db, self.owner["id"], code))
        self.assertTrue(verify_owner_mfa_code(self.db, self.owner["id"], new_codes[0]))


if __name__ == "__main__":
    unittest.main()
