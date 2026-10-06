from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class ConflictError(Exception):
    pass


class OAuthRefreshReplayError(Exception):
    pass


class SchemaVersionError(RuntimeError):
    pass


SCHEMA_VERSION = 4


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != "nt":
            os.chmod(self.path.parent, 0o700)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            schema_version = self._read_schema_version(connection)
            if schema_version > SCHEMA_VERSION:
                raise SchemaVersionError(
                    f"数据库 schema v{schema_version} 高于当前程序支持的 v{SCHEMA_VERSION}"
                )
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    password_hash TEXT NOT NULL,
                    is_owner INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS web_sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id);

                CREATE TABLE IF NOT EXISTS owner_mfa (
                    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    totp_secret TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS owner_recovery_codes (
                    code_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    used_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_owner_recovery_user
                    ON owner_recovery_codes(user_id, used_at);

                CREATE TABLE IF NOT EXISTS mcp_keys (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    prefix TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    last_used_at INTEGER,
                    revoked_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_mcp_keys_user ON mcp_keys(user_id);

                CREATE TABLE IF NOT EXISTS oauth_clients (
                    id TEXT PRIMARY KEY,
                    redirect_uris_json TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    client_name TEXT,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS oauth_codes (
                    code_hash TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    redirect_uri TEXT NOT NULL,
                    code_challenge TEXT NOT NULL,
                    scopes_json TEXT NOT NULL,
                    resource TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    used_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_codes(client_id);

                CREATE TABLE IF NOT EXISTS oauth_access_tokens (
                    token_hash TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    family_id TEXT NOT NULL,
                    scopes_json TEXT NOT NULL,
                    resource TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    revoked_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_oauth_access_user ON oauth_access_tokens(user_id);

                CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
                    token_hash TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    family_id TEXT NOT NULL,
                    scopes_json TEXT NOT NULL,
                    resource TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    revoked_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens(user_id);

                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    client_id TEXT,
                    tool_name TEXT NOT NULL,
                    action_summary TEXT NOT NULL,
                    cwd TEXT,
                    session_id TEXT,
                    exit_code INTEGER,
                    success INTEGER NOT NULL,
                    error TEXT,
                    duration_ms INTEGER NOT NULL,
                    request_id TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created
                    ON audit_logs(user_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS enrollment_tokens (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    prefix TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    used_at INTEGER,
                    revoked_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_enrollment_user ON enrollment_tokens(user_id);

                CREATE TABLE IF NOT EXISTS agents (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    profiles_json TEXT NOT NULL,
                    version_json TEXT NOT NULL DEFAULT '{}',
                    shell_policy_mode TEXT NOT NULL DEFAULT 'off'
                        CHECK (shell_policy_mode IN ('off', 'standard')),
                    credential_prefix TEXT NOT NULL,
                    credential_hash TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL,
                    revoked_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);

                CREATE TABLE IF NOT EXISTS agent_bundles (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    enrollment_token_id TEXT NOT NULL REFERENCES enrollment_tokens(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    runtime TEXT NOT NULL,
                    profiles_json TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_agent_bundles_user ON agent_bundles(user_id);
                """
            )
            migrations = (
                (1, self._migrate_owner_flag),
                (2, self._migrate_oauth_token_families),
                (3, self._migrate_agent_version),
                (4, self._migrate_shell_policy),
            )
            for target_version, migrate in migrations:
                if schema_version >= target_version:
                    continue
                migrate(connection)
                self._write_schema_version(connection, target_version)
                schema_version = target_version
        if os.name != "nt":
            os.chmod(self.path, 0o600)

    @staticmethod
    def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
        return {
            row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
        }

    @staticmethod
    def _read_schema_version(connection: sqlite3.Connection) -> int:
        row = connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'schema_version'"
        ).fetchone()
        if row is None:
            return 0
        try:
            version = int(row["value"])
        except (TypeError, ValueError) as exc:
            raise SchemaVersionError("数据库 schema version 无效") from exc
        if version < 0:
            raise SchemaVersionError("数据库 schema version 无效")
        return version

    @staticmethod
    def _write_schema_version(connection: sqlite3.Connection, version: int) -> None:
        connection.execute(
            """
            INSERT INTO schema_metadata (key, value)
            VALUES ('schema_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (str(version),),
        )

    @classmethod
    def _migrate_owner_flag(cls, connection: sqlite3.Connection) -> None:
        if "is_owner" not in cls._columns(connection, "users"):
            connection.execute(
                "ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0"
            )

    @classmethod
    def _migrate_oauth_token_families(cls, connection: sqlite3.Connection) -> None:
        if "family_id" not in cls._columns(connection, "oauth_access_tokens"):
            connection.execute(
                "ALTER TABLE oauth_access_tokens ADD COLUMN family_id TEXT NOT NULL DEFAULT ''"
            )
        if "family_id" not in cls._columns(connection, "oauth_refresh_tokens"):
            connection.execute(
                "ALTER TABLE oauth_refresh_tokens ADD COLUMN family_id TEXT NOT NULL DEFAULT ''"
            )
        migration_time = int(time.time())
        connection.execute(
            """
            UPDATE oauth_access_tokens
            SET revoked_at = COALESCE(revoked_at, ?)
            WHERE family_id = ''
            """,
            (migration_time,),
        )
        connection.execute(
            """
            UPDATE oauth_refresh_tokens
            SET revoked_at = COALESCE(revoked_at, ?)
            WHERE family_id = ''
            """,
            (migration_time,),
        )

    @classmethod
    def _migrate_agent_version(cls, connection: sqlite3.Connection) -> None:
        if "version_json" not in cls._columns(connection, "agents"):
            connection.execute(
                "ALTER TABLE agents ADD COLUMN version_json TEXT NOT NULL DEFAULT '{}'"
            )

    @classmethod
    def _migrate_shell_policy(cls, connection: sqlite3.Connection) -> None:
        if "shell_policy_mode" not in cls._columns(connection, "agents"):
            connection.execute(
                "ALTER TABLE agents ADD COLUMN shell_policy_mode TEXT NOT NULL DEFAULT 'off'"
            )

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    def create_user(
        self, email: str, password_hash: str, *, is_owner: bool = False
    ) -> dict[str, Any]:
        now = int(time.time())
        user_id = str(uuid.uuid4())
        try:
            with self.connect() as connection:
                connection.execute(
                    """
                    INSERT INTO users (id, email, password_hash, is_owner, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (user_id, email.strip().lower(), password_hash, 1 if is_owner else 0, now),
                )
        except sqlite3.IntegrityError as exc:
            raise ConflictError("该邮箱已注册") from exc
        return {
            "id": user_id,
            "email": email.strip().lower(),
            "is_owner": is_owner,
            "created_at": now,
        }

    def create_owner(self, email: str, password_hash: str) -> dict[str, Any]:
        now = int(time.time())
        user_id = str(uuid.uuid4())
        normalized = email.strip().lower()
        try:
            with self.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                owner = connection.execute(
                    "SELECT id FROM users WHERE is_owner = 1 LIMIT 1"
                ).fetchone()
                if owner is not None:
                    raise ConflictError("Owner 已存在")
                user_count = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
                if user_count:
                    raise ConflictError(
                        "数据库已存在非 Owner 用户；请迁移到全新数据目录后重新初始化"
                    )
                connection.execute(
                    """
                    INSERT INTO users (id, email, password_hash, is_owner, created_at)
                    VALUES (?, ?, ?, 1, ?)
                    """,
                    (user_id, normalized, password_hash, now),
                )
        except sqlite3.IntegrityError as exc:
            raise ConflictError("该邮箱已注册") from exc
        return {"id": user_id, "email": normalized, "is_owner": True, "created_at": now}

    def get_owner(self) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT id, email, is_owner, created_at FROM users WHERE is_owner = 1 LIMIT 1"
            ).fetchone()
        return self._row(row)

    def is_owner(self, user_id: str) -> bool:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM users WHERE id = ? AND is_owner = 1",
                (user_id,),
            ).fetchone()
        return row is not None

    def configure_owner_mfa(
        self,
        user_id: str,
        totp_secret: str,
        recovery_hashes: list[str],
    ) -> None:
        if not recovery_hashes:
            raise ValueError("至少需要一个恢复码")
        now = int(time.time())
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            owner = connection.execute(
                "SELECT 1 FROM users WHERE id = ? AND is_owner = 1",
                (user_id,),
            ).fetchone()
            if owner is None:
                raise ValueError("仅 Owner 可以配置 MFA")
            connection.execute(
                """
                INSERT INTO owner_mfa (user_id, totp_secret, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    totp_secret = excluded.totp_secret,
                    updated_at = excluded.updated_at
                """,
                (user_id, totp_secret, now, now),
            )
            connection.execute("DELETE FROM owner_recovery_codes WHERE user_id = ?", (user_id,))
            connection.executemany(
                """
                INSERT INTO owner_recovery_codes (code_hash, user_id, created_at)
                VALUES (?, ?, ?)
                """,
                [(digest, user_id, now) for digest in recovery_hashes],
            )
            connection.execute("DELETE FROM web_sessions WHERE user_id = ?", (user_id,))
            connection.execute("DELETE FROM oauth_codes WHERE user_id = ?", (user_id,))
            connection.execute(
                """
                UPDATE oauth_access_tokens
                SET revoked_at = COALESCE(revoked_at, ?)
                WHERE user_id = ?
                """,
                (now, user_id),
            )
            connection.execute(
                """
                UPDATE oauth_refresh_tokens
                SET revoked_at = COALESCE(revoked_at, ?)
                WHERE user_id = ?
                """,
                (now, user_id),
            )

    def has_owner_mfa(self, user_id: str) -> bool:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM owner_mfa WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return row is not None

    def get_owner_mfa_secret(self, user_id: str) -> str | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT totp_secret FROM owner_mfa WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return str(row["totp_secret"]) if row is not None else None

    def consume_owner_recovery_code(self, user_id: str, code_hash: str) -> bool:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT 1 FROM owner_recovery_codes
                WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
                """,
                (user_id, code_hash),
            ).fetchone()
            if row is None:
                return False
            connection.execute(
                """
                UPDATE owner_recovery_codes SET used_at = ?
                WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
                """,
                (now, user_id, code_hash),
            )
        return True

    def count_unused_owner_recovery_codes(self, user_id: str) -> int:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS count FROM owner_recovery_codes
                WHERE user_id = ? AND used_at IS NULL
                """,
                (user_id,),
            ).fetchone()
        return int(row["count"])

    def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email.strip(),)
            ).fetchone()
        return self._row(row)

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT id, email, is_owner, created_at FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return self._row(row)

    def create_session(self, token_hash: str, user_id: str, expires_at: int) -> None:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO web_sessions VALUES (?, ?, ?, ?, ?)",
                (token_hash, user_id, expires_at, now, now),
            )

    def get_session_user(self, token_hash: str) -> dict[str, Any] | None:
        now = int(time.time())
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT users.id, users.email, users.is_owner, users.created_at
                FROM web_sessions
                JOIN users ON users.id = web_sessions.user_id
                WHERE web_sessions.token_hash = ? AND web_sessions.expires_at > ?
                """,
                (token_hash, now),
            ).fetchone()
            if row is not None:
                connection.execute(
                    "UPDATE web_sessions SET last_seen_at = ? WHERE token_hash = ?",
                    (now, token_hash),
                )
        return self._row(row)

    def delete_session(self, token_hash: str) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM web_sessions WHERE token_hash = ?", (token_hash,))

    def create_mcp_key(
        self, user_id: str, name: str, prefix: str, token_hash: str
    ) -> dict[str, Any]:
        key_id = str(uuid.uuid4())
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO mcp_keys
                    (id, user_id, name, prefix, token_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (key_id, user_id, name, prefix, token_hash, now),
            )
        return {"id": key_id, "name": name, "prefix": prefix, "created_at": now}

    def list_mcp_keys(self, user_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, name, prefix, created_at, last_used_at, revoked_at
                FROM mcp_keys WHERE user_id = ? ORDER BY created_at DESC
                """,
                (user_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def revoke_mcp_key(self, user_id: str, key_id: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE mcp_keys SET revoked_at = COALESCE(revoked_at, ?)
                WHERE id = ? AND user_id = ?
                """,
                (int(time.time()), key_id, user_id),
            )
        return cursor.rowcount > 0

    def verify_mcp_key(self, token_hash: str) -> dict[str, Any] | None:
        now = int(time.time())
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT mcp_keys.id AS key_id, mcp_keys.user_id, users.email
                FROM mcp_keys
                JOIN users ON users.id = mcp_keys.user_id
                WHERE mcp_keys.token_hash = ? AND mcp_keys.revoked_at IS NULL
                """,
                (token_hash,),
            ).fetchone()
            if row is not None:
                connection.execute(
                    "UPDATE mcp_keys SET last_used_at = ? WHERE id = ?", (now, row["key_id"])
                )
        return self._row(row)

    def create_oauth_client(
        self,
        client_id: str,
        redirect_uris: list[str],
        scope: str,
        client_name: str | None,
    ) -> dict[str, Any]:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO oauth_clients
                    (id, redirect_uris_json, scope, client_name, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    client_id,
                    json.dumps(redirect_uris, separators=(",", ":")),
                    scope,
                    client_name,
                    now,
                ),
            )
        return {
            "id": client_id,
            "redirect_uris": redirect_uris,
            "scope": scope,
            "client_name": client_name,
            "created_at": now,
        }

    def get_oauth_client(self, client_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM oauth_clients WHERE id = ?",
                (client_id,),
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["redirect_uris"] = json.loads(result.pop("redirect_uris_json"))
        return result

    def create_oauth_code(
        self,
        *,
        code_hash: str,
        client_id: str,
        user_id: str,
        redirect_uri: str,
        code_challenge: str,
        scopes: list[str],
        resource: str,
        expires_at: int,
    ) -> None:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO oauth_codes
                    (code_hash, client_id, user_id, redirect_uri, code_challenge,
                     scopes_json, resource, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    code_hash,
                    client_id,
                    user_id,
                    redirect_uri,
                    code_challenge,
                    json.dumps(scopes, separators=(",", ":")),
                    resource,
                    expires_at,
                    now,
                ),
            )

    def consume_oauth_code(
        self,
        *,
        code_hash: str,
        client_id: str,
        redirect_uri: str,
        code_challenge: str,
        resource: str,
    ) -> dict[str, Any] | None:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT * FROM oauth_codes
                WHERE code_hash = ? AND client_id = ? AND redirect_uri = ?
                  AND code_challenge = ? AND resource = ?
                  AND used_at IS NULL AND expires_at > ?
                """,
                (code_hash, client_id, redirect_uri, code_challenge, resource, now),
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                "UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?",
                (now, code_hash),
            )
        result = dict(row)
        result["scopes"] = json.loads(result.pop("scopes_json"))
        return result

    def create_oauth_access_token(
        self,
        *,
        token_hash: str,
        client_id: str,
        user_id: str,
        family_id: str,
        scopes: list[str],
        resource: str,
        expires_at: int,
    ) -> None:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO oauth_access_tokens
                    (token_hash, client_id, user_id, family_id, scopes_json,
                     resource, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    token_hash,
                    client_id,
                    user_id,
                    family_id,
                    json.dumps(scopes, separators=(",", ":")),
                    resource,
                    expires_at,
                    now,
                ),
            )

    def verify_oauth_access_token(self, token_hash: str) -> dict[str, Any] | None:
        now = int(time.time())
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT oauth_access_tokens.*, users.email
                FROM oauth_access_tokens
                JOIN users ON users.id = oauth_access_tokens.user_id
                WHERE oauth_access_tokens.token_hash = ?
                  AND oauth_access_tokens.revoked_at IS NULL
                  AND oauth_access_tokens.expires_at > ?
                """,
                (token_hash, now),
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["scopes"] = json.loads(result.pop("scopes_json"))
        return result

    def create_oauth_refresh_token(
        self,
        *,
        token_hash: str,
        client_id: str,
        user_id: str,
        family_id: str,
        scopes: list[str],
        resource: str,
        expires_at: int,
    ) -> None:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO oauth_refresh_tokens
                    (token_hash, client_id, user_id, family_id, scopes_json,
                     resource, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    token_hash,
                    client_id,
                    user_id,
                    family_id,
                    json.dumps(scopes, separators=(",", ":")),
                    resource,
                    expires_at,
                    now,
                ),
            )

    def consume_oauth_refresh_token(
        self, token_hash: str, client_id: str, resource: str
    ) -> dict[str, Any] | None:
        now = int(time.time())
        replay_detected = False
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT * FROM oauth_refresh_tokens
                WHERE token_hash = ? AND client_id = ? AND resource = ?
                  AND expires_at > ?
                """,
                (token_hash, client_id, resource, now),
            ).fetchone()
            if row is None:
                return None
            if row["revoked_at"] is not None:
                family_id = row["family_id"]
                if family_id:
                    connection.execute(
                        """
                        UPDATE oauth_refresh_tokens
                        SET revoked_at = COALESCE(revoked_at, ?)
                        WHERE family_id = ?
                        """,
                        (now, family_id),
                    )
                    connection.execute(
                        """
                        UPDATE oauth_access_tokens
                        SET revoked_at = COALESCE(revoked_at, ?)
                        WHERE family_id = ?
                        """,
                        (now, family_id),
                    )
                replay_detected = True
            else:
                connection.execute(
                    "UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?",
                    (now, token_hash),
                )
        if replay_detected:
            raise OAuthRefreshReplayError("refresh token replay detected")
        result = dict(row)
        result["scopes"] = json.loads(result.pop("scopes_json"))
        return result

    def revoke_oauth_token(self, token_hash: str) -> None:
        now = int(time.time())
        with self.connect() as connection:
            access = connection.execute(
                "SELECT family_id FROM oauth_access_tokens WHERE token_hash = ?",
                (token_hash,),
            ).fetchone()
            refresh = connection.execute(
                "SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = ?",
                (token_hash,),
            ).fetchone()
            family_id = (access or refresh)["family_id"] if (access or refresh) is not None else None
            if family_id:
                connection.execute(
                    "UPDATE oauth_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?",
                    (now, family_id),
                )
                connection.execute(
                    "UPDATE oauth_refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?",
                    (now, family_id),
                )
            else:
                connection.execute(
                    "UPDATE oauth_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?",
                    (now, token_hash),
                )
                connection.execute(
                    "UPDATE oauth_refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?",
                    (now, token_hash),
                )

    def create_audit_log(
        self,
        *,
        user_id: str,
        client_id: str | None,
        tool_name: str,
        action_summary: str,
        cwd: str | None,
        session_id: str | None,
        exit_code: int | None,
        success: bool,
        error: str | None,
        duration_ms: int,
        request_id: str | None,
    ) -> None:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO audit_logs
                    (user_id, client_id, tool_name, action_summary, cwd, session_id,
                     exit_code, success, error, duration_ms, request_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    client_id,
                    tool_name,
                    action_summary[:4000],
                    cwd,
                    session_id,
                    exit_code,
                    1 if success else 0,
                    error[:2000] if error else None,
                    max(0, duration_ms),
                    request_id,
                    now,
                ),
            )

    def list_audit_logs(self, user_id: str, limit: int = 200) -> list[dict[str, Any]]:
        bounded = max(1, min(limit, 500))
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, client_id, tool_name, action_summary, cwd, session_id,
                       exit_code, success, error, duration_ms, request_id, created_at
                FROM audit_logs
                WHERE user_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (user_id, bounded),
            ).fetchall()
        return [dict(row) for row in rows]

    def create_enrollment_token(
        self,
        user_id: str,
        name: str,
        prefix: str,
        token_hash: str,
        expires_at: int,
    ) -> dict[str, Any]:
        token_id = str(uuid.uuid4())
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO enrollment_tokens
                    (id, user_id, name, prefix, token_hash, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (token_id, user_id, name, prefix, token_hash, now, expires_at),
            )
        return {
            "id": token_id,
            "name": name,
            "prefix": prefix,
            "created_at": now,
            "expires_at": expires_at,
        }

    def list_enrollment_tokens(self, user_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, name, prefix, created_at, expires_at, used_at, revoked_at
                FROM enrollment_tokens WHERE user_id = ? ORDER BY created_at DESC
                """,
                (user_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def revoke_enrollment_token(self, user_id: str, token_id: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE enrollment_tokens SET revoked_at = COALESCE(revoked_at, ?)
                WHERE id = ? AND user_id = ? AND used_at IS NULL
                """,
                (int(time.time()), token_id, user_id),
            )
        return cursor.rowcount > 0

    def register_agent(
        self,
        enrollment_hash: str,
        agent_id: str,
        credential_prefix: str,
        credential_hash: str,
        name: str,
        description: str,
        profile_declarations: list[dict[str, Any]],
        version: dict[str, Any],
    ) -> dict[str, Any] | None:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            enrollment = connection.execute(
                """
                SELECT id, user_id FROM enrollment_tokens
                WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
                """,
                (enrollment_hash, now),
            ).fetchone()
            if enrollment is None:
                return None
            connection.execute(
                "UPDATE enrollment_tokens SET used_at = ? WHERE id = ?",
                (now, enrollment["id"]),
            )
            connection.execute(
                """
                INSERT INTO agents
                    (id, user_id, name, description, profiles_json, version_json,
                     credential_prefix, credential_hash, created_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    agent_id,
                    enrollment["user_id"],
                    name,
                    description,
                    json.dumps(profile_declarations, separators=(",", ":")),
                    json.dumps(version, separators=(",", ":")),
                    credential_prefix,
                    credential_hash,
                    now,
                    now,
                ),
            )
        return {"id": agent_id, "user_id": enrollment["user_id"]}

    def authenticate_agent(self, agent_id: str, credential_hash: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT id, user_id, name, description, profiles_json, version_json,
                       shell_policy_mode, created_at, last_seen_at
                FROM agents
                WHERE id = ? AND credential_hash = ? AND revoked_at IS NULL
                """,
                (agent_id, credential_hash),
            ).fetchone()
        return self._agent_row(row)

    @staticmethod
    def _agent_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        result = dict(row)
        raw_declarations = json.loads(result.pop("profiles_json"))
        declarations = (
            [
                declaration
                for declaration in raw_declarations
                if isinstance(declaration, dict)
                and isinstance(declaration.get("id"), str)
                and isinstance(declaration.get("runtime"), dict)
            ]
            if isinstance(raw_declarations, list)
            else []
        )
        result["profile_declarations"] = declarations
        result["profiles"] = [declaration["id"] for declaration in declarations]
        raw_version = json.loads(result.pop("version_json"))
        result["version"] = raw_version if isinstance(raw_version, dict) else {}
        mode = result.get("shell_policy_mode")
        result["shell_policy_mode"] = mode if mode in {"off", "standard"} else "off"
        return result

    def update_agent_runtime(
        self,
        agent_id: str,
        declarations: list[dict[str, Any]],
        version: dict[str, Any],
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE agents SET profiles_json = ?, version_json = ?
                WHERE id = ? AND revoked_at IS NULL
                """,
                (
                    json.dumps(declarations, separators=(",", ":")),
                    json.dumps(version, separators=(",", ":")),
                    agent_id,
                ),
            )

    def touch_agent(self, agent_id: str) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE agents SET last_seen_at = ? WHERE id = ?", (int(time.time()), agent_id)
            )

    def list_agents(self, user_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, user_id, name, description, profiles_json, version_json,
                       shell_policy_mode, created_at, last_seen_at, revoked_at
                FROM agents
                WHERE user_id = ? AND revoked_at IS NULL
                ORDER BY created_at DESC
                """,
                (user_id,),
            ).fetchall()
        return [self._agent_row(row) for row in rows if row is not None]

    def get_owned_agent(self, user_id: str, agent_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT id, user_id, name, description, profiles_json, version_json,
                       shell_policy_mode, created_at, last_seen_at, revoked_at
                FROM agents WHERE id = ? AND user_id = ? AND revoked_at IS NULL
                """,
                (agent_id, user_id),
            ).fetchone()
        return self._agent_row(row)

    def update_agent(self, user_id: str, agent_id: str, name: str, description: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE agents SET name = ?, description = ?
                WHERE id = ? AND user_id = ? AND revoked_at IS NULL
                """,
                (name, description, agent_id, user_id),
            )
        return cursor.rowcount > 0

    def update_agent_shell_policy(
        self, user_id: str, agent_id: str, mode: str
    ) -> bool:
        if mode not in {"off", "standard"}:
            raise ValueError("shell_policy_mode 无效")
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE agents SET shell_policy_mode = ?
                WHERE id = ? AND user_id = ? AND revoked_at IS NULL
                """,
                (mode, agent_id, user_id),
            )
        return cursor.rowcount > 0

    def revoke_agent(self, user_id: str, agent_id: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE agents SET revoked_at = COALESCE(revoked_at, ?)
                WHERE id = ? AND user_id = ?
                """,
                (int(time.time()), agent_id, user_id),
            )
        return cursor.rowcount > 0

    def create_agent_bundle(
        self,
        bundle_id: str,
        user_id: str,
        enrollment_token_id: str,
        name: str,
        description: str,
        runtime: str,
        profiles: list[str],
        filename: str,
        expires_at: int,
    ) -> dict[str, Any]:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO agent_bundles
                    (id, user_id, enrollment_token_id, name, description, runtime,
                     profiles_json, filename, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    bundle_id,
                    user_id,
                    enrollment_token_id,
                    name,
                    description,
                    runtime,
                    json.dumps(profiles, separators=(",", ":")),
                    filename,
                    now,
                    expires_at,
                ),
            )
        return {
            "id": bundle_id,
            "name": name,
            "description": description,
            "runtime": runtime,
            "profiles": profiles,
            "filename": filename,
            "created_at": now,
            "expires_at": expires_at,
        }

    @staticmethod
    def _bundle_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        result = dict(row)
        result["profiles"] = json.loads(result.pop("profiles_json"))
        return result

    def list_agent_bundles(self, user_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, name, description, runtime, profiles_json, filename,
                       created_at, expires_at
                FROM agent_bundles WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
                """,
                (user_id,),
            ).fetchall()
        return [self._bundle_row(row) for row in rows if row is not None]

    def get_owned_agent_bundle(self, user_id: str, bundle_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT id, name, description, runtime, profiles_json, filename,
                       created_at, expires_at
                FROM agent_bundles WHERE id = ? AND user_id = ?
                """,
                (bundle_id, user_id),
            ).fetchone()
        return self._bundle_row(row)

    def get_installable_agent_bundle(
        self,
        bundle_id: str,
        enrollment_hash: str,
    ) -> dict[str, Any] | None:
        """Return a still-installable bundle authorized by its enrollment token.

        This deliberately does not consume the token. The token remains single-use at
        the Agent WebSocket registration boundary; this lookup only authorizes fetching
        the already-built runtime bytes on the target machine.
        """
        now = int(time.time())
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT b.id, b.name, b.description, b.runtime, b.profiles_json,
                       b.filename, b.created_at, b.expires_at
                FROM agent_bundles AS b
                JOIN enrollment_tokens AS t ON t.id = b.enrollment_token_id
                WHERE b.id = ?
                  AND t.token_hash = ?
                  AND t.used_at IS NULL
                  AND t.revoked_at IS NULL
                  AND t.expires_at > ?
                  AND b.expires_at > ?
                """,
                (bundle_id, enrollment_hash, now, now),
            ).fetchone()
        return self._bundle_row(row)

    def cleanup_expired_agent_bundles(self) -> list[str]:
        now = int(time.time())
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT filename FROM agent_bundles WHERE expires_at <= ?", (now,)
            ).fetchall()
            connection.execute("DELETE FROM agent_bundles WHERE expires_at <= ?", (now,))
        return [row["filename"] for row in rows]
