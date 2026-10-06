from __future__ import annotations

import sqlite3
import tempfile
import time
import unittest
import uuid
import os
from contextlib import closing
from pathlib import Path

from gateway.database import (
    SCHEMA_VERSION,
    ConflictError,
    Database,
    OAuthRefreshReplayError,
    SchemaVersionError,
)
from gateway.security import hash_password, hash_token, issue_token, verify_password


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
AGENT_VERSION = {
    "agent_version": "0.1.0",
    "core_version": 1,
    "protocol_version": 2,
    "build_id": "test-build",
}


class DatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.tempdir.name) / "test.db")
        self.db.initialize()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def create_user(self, email: str = "owner@example.com") -> dict:
        return self.db.create_user(email, hash_password("correct horse battery staple"))

    def test_password_hash_is_salted_and_verifiable(self) -> None:
        first = hash_password("correct horse battery staple")
        second = hash_password("correct horse battery staple")
        self.assertNotEqual(first, second)
        self.assertTrue(verify_password("correct horse battery staple", first))
        self.assertFalse(verify_password("wrong password", first))

    @unittest.skipIf(os.name == "nt", "POSIX permission bits are not available on Windows")
    def test_database_and_parent_directory_are_private(self) -> None:
        directory_mode = self.db.path.parent.stat().st_mode & 0o777
        database_mode = self.db.path.stat().st_mode & 0o777
        self.assertEqual(directory_mode, 0o700)
        self.assertEqual(database_mode, 0o600)

    def test_initialize_records_current_schema_version(self) -> None:
        with closing(sqlite3.connect(self.db.path)) as connection:
            row = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = 'schema_version'"
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(int(row[0]), SCHEMA_VERSION)

    def test_initialize_rejects_database_from_newer_runtime(self) -> None:
        path = Path(self.tempdir.name) / "future.db"
        with closing(sqlite3.connect(path)) as connection:
            connection.execute(
                "CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            connection.execute(
                "INSERT INTO schema_metadata (key, value) VALUES ('schema_version', ?)",
                (str(SCHEMA_VERSION + 1),),
            )
            connection.commit()

        with self.assertRaisesRegex(SchemaVersionError, "高于当前程序支持"):
            Database(path).initialize()

        with closing(sqlite3.connect(path)) as connection:
            users = connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
            ).fetchone()
        self.assertIsNone(users)

    def test_owner_mfa_rotation_revokes_sessions_and_oauth_family(self) -> None:
        owner = self.db.create_owner("mfa-owner@example.com", hash_password("owner-test-password"))
        session = issue_token("session")
        self.db.create_session(session.digest, owner["id"], int(time.time()) + 300)

        client_id = "mfa-client"
        resource = "https://gateway.example.com/mcp/"
        self.db.create_oauth_client(
            client_id,
            ["https://example.com/callback"],
            "gateway:use offline_access",
            "test-client",
        )
        access = issue_token("oauth")
        refresh = issue_token("oauthr")
        self.db.create_oauth_access_token(
            token_hash=access.digest,
            client_id=client_id,
            user_id=owner["id"],
            family_id="family-1",
            scopes=["gateway:use", "offline_access"],
            resource=resource,
            expires_at=int(time.time()) + 300,
        )
        self.db.create_oauth_refresh_token(
            token_hash=refresh.digest,
            client_id=client_id,
            user_id=owner["id"],
            family_id="family-1",
            scopes=["gateway:use", "offline_access"],
            resource=resource,
            expires_at=int(time.time()) + 300,
        )

        self.db.configure_owner_mfa(
            owner["id"],
            "JBSWY3DPEHPK3PXP",
            [hash_token("RECOVERYCODE1234")],
        )

        self.assertIsNone(self.db.get_session_user(session.digest))
        self.assertIsNone(self.db.verify_oauth_access_token(access.digest))
        with self.assertRaises(OAuthRefreshReplayError):
            self.db.consume_oauth_refresh_token(refresh.digest, client_id, resource)

    def test_email_is_unique_case_insensitively(self) -> None:
        self.create_user("Owner@Example.com")
        with self.assertRaises(ConflictError):
            self.create_user("owner@example.com")

    def test_owner_bootstrap_requires_empty_database_and_is_unique(self) -> None:
        owner = self.db.create_owner(
            "owner-local@example.com",
            hash_password("correct horse battery staple"),
        )
        self.assertTrue(owner["is_owner"])
        self.assertTrue(self.db.is_owner(owner["id"]))
        self.assertEqual(self.db.get_owner()["email"], "owner-local@example.com")
        with self.assertRaisesRegex(ConflictError, "Owner 已存在"):
            self.db.create_owner(
                "second-owner@example.com",
                hash_password("correct horse battery staple"),
            )

    def test_owner_bootstrap_refuses_existing_regular_user(self) -> None:
        self.create_user("existing@example.com")
        with self.assertRaisesRegex(ConflictError, "已存在非 Owner 用户"):
            self.db.create_owner(
                "owner-local@example.com",
                hash_password("correct horse battery staple"),
            )

    def test_enrollment_token_is_consumed_once(self) -> None:
        user = self.create_user()
        enrollment = issue_token("enroll")
        self.db.create_enrollment_token(
            user["id"], "notebook", enrollment.prefix, enrollment.digest, int(time.time()) + 60
        )

        credential = issue_token("agent")
        agent_id = str(uuid.uuid4())
        registered = self.db.register_agent(
            enrollment.digest,
            agent_id,
            credential.prefix,
            credential.digest,
            "gpu-notebook",
            "模型训练环境",
            SHELL_DECLARATIONS,
            AGENT_VERSION,
        )
        self.assertEqual(registered["user_id"], user["id"])
        self.assertIsNone(
            self.db.register_agent(
                enrollment.digest,
                str(uuid.uuid4()),
                credential.prefix,
                hash_token("another"),
                "duplicate",
                "",
                SHELL_DECLARATIONS,
                AGENT_VERSION,
            )
        )

    def test_agent_queries_are_owner_scoped(self) -> None:
        owner = self.create_user()
        other = self.create_user("other@example.com")
        enrollment = issue_token("enroll")
        self.db.create_enrollment_token(
            owner["id"], "agent", enrollment.prefix, enrollment.digest, int(time.time()) + 60
        )
        credential = issue_token("agent")
        agent_id = str(uuid.uuid4())
        self.db.register_agent(
            enrollment.digest,
            agent_id,
            credential.prefix,
            credential.digest,
            "private-agent",
            "",
            SHELL_DECLARATIONS,
            AGENT_VERSION,
        )

        agent = self.db.get_owned_agent(owner["id"], agent_id)
        self.assertIsNotNone(agent)
        self.assertEqual(agent["profiles"], ["shell.v1"])
        self.assertEqual(agent["profile_declarations"], SHELL_DECLARATIONS)
        self.assertEqual(agent["version"], AGENT_VERSION)
        self.assertEqual(agent["shell_policy_mode"], "off")
        self.assertTrue(self.db.update_agent_shell_policy(owner["id"], agent_id, "standard"))
        self.assertEqual(
            self.db.get_owned_agent(owner["id"], agent_id)["shell_policy_mode"], "standard"
        )
        self.assertIsNone(self.db.get_owned_agent(other["id"], agent_id))
        self.assertEqual(self.db.list_agents(other["id"]), [])
        self.assertTrue(self.db.revoke_agent(owner["id"], agent_id))
        self.assertEqual(self.db.list_agents(owner["id"]), [])

    def test_legacy_profile_rows_are_not_treated_as_protocol_v2_capabilities(self) -> None:
        user = self.create_user()
        enrollment = issue_token("enroll")
        self.db.create_enrollment_token(
            user["id"], "legacy", enrollment.prefix, enrollment.digest, int(time.time()) + 60
        )
        credential = issue_token("agent")
        agent_id = str(uuid.uuid4())
        self.db.register_agent(
            enrollment.digest,
            agent_id,
            credential.prefix,
            credential.digest,
            "legacy-agent",
            "",
            ["shell.v1"],  # type: ignore[arg-type]
            {},
        )

        agent = self.db.get_owned_agent(user["id"], agent_id)
        self.assertEqual(agent["profiles"], [])
        self.assertEqual(agent["profile_declarations"], [])
        self.assertEqual(agent["version"], {})

    def test_initialize_adds_version_column_to_existing_agent_table(self) -> None:
        path = Path(self.tempdir.name) / "legacy.db"
        with closing(sqlite3.connect(path)) as connection:
            connection.execute(
                """
                CREATE TABLE agents (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    profiles_json TEXT NOT NULL,
                    credential_prefix TEXT NOT NULL,
                    credential_hash TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL,
                    revoked_at INTEGER
                )
                """
            )
            connection.commit()
        Database(path).initialize()
        with closing(sqlite3.connect(path)) as connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(agents)")}
            schema_version = int(
                connection.execute(
                    "SELECT value FROM schema_metadata WHERE key = 'schema_version'"
                ).fetchone()[0]
            )
        self.assertIn("version_json", columns)
        self.assertIn("shell_policy_mode", columns)
        self.assertEqual(schema_version, SCHEMA_VERSION)

    def test_revoked_mcp_key_cannot_authenticate(self) -> None:
        user = self.create_user()
        token = issue_token("mcp")
        key = self.db.create_mcp_key(user["id"], "Claude", token.prefix, token.digest)
        self.assertEqual(self.db.verify_mcp_key(token.digest)["user_id"], user["id"])
        self.assertTrue(self.db.revoke_mcp_key(user["id"], key["id"]))
        self.assertIsNone(self.db.verify_mcp_key(token.digest))


if __name__ == "__main__":
    unittest.main()
