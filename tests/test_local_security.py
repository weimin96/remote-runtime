from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import Settings
from gateway.database import Database
from gateway.security import hash_password


class LocalSecurityTests(unittest.TestCase):
    def test_local_mode_requires_https_for_public_url(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            with patch.dict(
                os.environ,
                {
                    "GATEWAY_PUBLIC_URL": "http://gateway.example.com",
                    "GATEWAY_LOCAL_WORKDIR": tempdir,
                    "GATEWAY_DATA_DIR": str(Path(tempdir) / "data"),
                },
                clear=True,
            ):
                with self.assertRaisesRegex(ValueError, "必须使用 HTTPS"):
                    Settings.from_env()

    def test_local_mode_requires_secure_cookie_on_https(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            with patch.dict(
                os.environ,
                {
                    "GATEWAY_PUBLIC_URL": "https://gateway.example.com",
                    "GATEWAY_SECURE_COOKIES": "false",
                    "GATEWAY_LOCAL_WORKDIR": tempdir,
                    "GATEWAY_DATA_DIR": str(Path(tempdir) / "data"),
                },
                clear=True,
            ):
                with self.assertRaisesRegex(ValueError, "必须启用 GATEWAY_SECURE_COOKIES"):
                    Settings.from_env()

    def test_local_mode_requires_loopback_bind(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            with patch.dict(
                os.environ,
                {
                    "GATEWAY_PUBLIC_URL": "https://gateway.example.com",
                    "GATEWAY_HOST": "0.0.0.0",
                    "GATEWAY_SECURE_COOKIES": "true",
                    "GATEWAY_LOCAL_WORKDIR": tempdir,
                    "GATEWAY_DATA_DIR": str(Path(tempdir) / "data"),
                },
                clear=True,
            ):
                with self.assertRaisesRegex(ValueError, "loopback"):
                    Settings.from_env()

    def test_public_local_mode_requires_separate_exec_user(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            with patch.dict(
                os.environ,
                {
                    "GATEWAY_PUBLIC_URL": "https://gateway.example.com",
                    "GATEWAY_HOST": "127.0.0.1",
                    "GATEWAY_SECURE_COOKIES": "true",
                    "GATEWAY_LOCAL_WORKDIR": tempdir,
                    "GATEWAY_DATA_DIR": str(Path(tempdir) / "data"),
                },
                clear=True,
            ):
                with self.assertRaisesRegex(ValueError, "GATEWAY_LOCAL_EXEC_USER"):
                    Settings.from_env()

    def test_public_local_mode_accepts_separate_exec_user_setting(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            with patch.dict(
                os.environ,
                {
                    "GATEWAY_PUBLIC_URL": "https://gateway.example.com",
                    "GATEWAY_HOST": "127.0.0.1",
                    "GATEWAY_SECURE_COOKIES": "true",
                    "GATEWAY_LOCAL_WORKDIR": tempdir,
                    "GATEWAY_LOCAL_EXEC_USER": "remote-agent-runner",
                    "GATEWAY_DATA_DIR": str(Path(tempdir) / "data"),
                },
                clear=True,
            ):
                settings = Settings.from_env()
        self.assertEqual(settings.local_exec_user, "remote-agent-runner")

    def test_local_mode_parses_multiple_workspace_roots(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            primary = root / "primary"
            extra_a = root / "extra-a"
            extra_b = root / "extra-b"
            primary.mkdir()
            extra_a.mkdir()
            extra_b.mkdir()
            with patch.dict(
                os.environ,
                {
                    "GATEWAY_PUBLIC_URL": "http://127.0.0.1:8000",
                    "GATEWAY_LOCAL_WORKDIR": str(primary),
                    "GATEWAY_LOCAL_WORKDIRS": os.pathsep.join(
                        [str(extra_a), str(extra_b), str(primary)]
                    ),
                    "GATEWAY_DATA_DIR": str(root / "data"),
                },
                clear=True,
            ):
                settings = Settings.from_env()
        self.assertEqual(
            settings.local_workdirs,
            (primary.resolve(), extra_a.resolve(), extra_b.resolve()),
        )

    def test_extra_workspace_roots_require_primary_root(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            with patch.dict(
                os.environ,
                {
                    "GATEWAY_PUBLIC_URL": "http://127.0.0.1:8000",
                    "GATEWAY_LOCAL_WORKDIRS": tempdir,
                    "GATEWAY_DATA_DIR": str(Path(tempdir) / "data"),
                },
                clear=True,
            ):
                with self.assertRaisesRegex(ValueError, "需要同时设置"):
                    Settings.from_env()

    def test_local_mode_refuses_to_start_without_bootstrapped_owner(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            workspace = root / "workspace"
            workspace.mkdir()
            settings = Settings(
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
            with self.assertRaisesRegex(RuntimeError, "bootstrap_owner"):
                with TestClient(create_app(settings)):
                    pass

    def test_local_mode_does_not_publish_remote_agent_installer(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            workspace = root / "workspace"
            workspace.mkdir()
            settings = Settings(
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
            app = create_app(settings)
            paths = {route.path for route in app.routes if hasattr(route, "path")}
            self.assertNotIn("/install-agent.sh", paths)
            self.assertNotIn("/upgrade-agent.sh", paths)

    def test_public_local_mode_refuses_owner_without_mfa(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            workspace = root / "workspace"
            workspace.mkdir()
            settings = Settings(
                host="127.0.0.1",
                port=8000,
                public_url="https://gateway.example.com",
                data_dir=root / "data",
                database_path=root / "data" / "gateway.db",
                session_days=1,
                enrollment_minutes=30,
                max_command_timeout=60,
                secure_cookies=True,
                local_workdir=workspace,
                local_exec_user="remote-agent-runner",
            )
            database = Database(settings.database_path)
            database.initialize()
            database.create_owner(
                "owner@example.com",
                hash_password("correct horse battery staple"),
            )
            with self.assertRaisesRegex(RuntimeError, "configure_mfa"):
                with TestClient(create_app(settings)):
                    pass


if __name__ == "__main__":
    unittest.main()
