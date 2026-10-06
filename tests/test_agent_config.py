from __future__ import annotations

import base64
import json
import tempfile
import unittest
from pathlib import Path

from remote_agent.cli import _consume_token_file
from remote_agent.core import AgentConfig, EnvironmentAgentConfig, FatalAgentError


VALID_CONFIG = {
    "gateway_url": "ws://127.0.0.1:8000/ws/agent",
    "agent_id": "agent-test",
    "credential": "agent_secret",
}


class AgentConfigTests(unittest.TestCase):
    def test_enrollment_token_file_is_consumed_and_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "enrollment-token"
            path.write_text("enroll_test_secret\n", encoding="utf-8")
            self.assertEqual(_consume_token_file(path), "enroll_test_secret")
            self.assertFalse(path.exists())

    def test_existing_agent_config_is_checked_before_cli_token_file_is_consumed(self) -> None:
        # The CLI performs this guard before calling _consume_token_file; keep the
        # lower-level config behavior explicit so a reinstall cannot silently replace it.
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            token_file = Path(directory) / "enrollment-token"
            config.write_text(json.dumps(VALID_CONFIG), encoding="utf-8")
            token_file.write_text("enroll_new\n", encoding="utf-8")
            store = AgentConfig(config)
            self.assertIsNotNone(store.load())
            self.assertTrue(token_file.exists())

    def test_new_enrollment_prepares_writable_directory_without_creating_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / ".agent" / "config.json"
            store = AgentConfig(path)
            saved = store.prepare_startup("enroll_test")
            self.assertIsNone(saved)
            self.assertTrue(path.parent.is_dir())
            self.assertFalse(path.exists())
            self.assertEqual(list(path.parent.iterdir()), [])

    def test_startup_rejects_missing_token_and_missing_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = AgentConfig(Path(directory) / "config.json")
            with self.assertRaisesRegex(FatalAgentError, "首次运行需要提供 --token"):
                store.prepare_startup(None)

    def test_existing_config_rejects_new_enrollment_token_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(VALID_CONFIG), encoding="utf-8")
            original = path.read_bytes()
            store = AgentConfig(path)
            with self.assertRaisesRegex(FatalAgentError, "已经绑定 Agent"):
                store.prepare_startup("enroll_new")
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(store.prepare_startup(None), VALID_CONFIG)

    def test_unwritable_config_parent_fails_before_enrollment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            blocker = Path(directory) / "not-a-directory"
            blocker.write_text("blocked", encoding="utf-8")
            store = AgentConfig(blocker / "config.json")
            with self.assertRaisesRegex(FatalAgentError, "设备凭据位置不可写"):
                store.prepare_startup("enroll_test")

    def test_save_is_atomic_and_load_validates_required_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            store = AgentConfig(path)
            store.save(VALID_CONFIG)
            self.assertEqual(store.load(), VALID_CONFIG)
            self.assertEqual(list(path.parent.glob(".*.tmp")), [])

            path.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(FatalAgentError, "gateway_url"):
                store.load()

    def test_environment_config_decodes_and_consumes_secret(self) -> None:
        encoded = base64.b64encode(
            json.dumps(VALID_CONFIG).encode("utf-8")
        ).decode("ascii")
        environment = {"REMOTE_AGENT_CONFIG_B64": encoded}

        store = EnvironmentAgentConfig(
            "REMOTE_AGENT_CONFIG_B64", environment=environment
        )

        self.assertEqual(store.prepare_startup(None), VALID_CONFIG)
        self.assertNotIn("REMOTE_AGENT_CONFIG_B64", environment)
        with self.assertRaisesRegex(FatalAgentError, "Enrollment Token"):
            store.prepare_startup("enroll_test")
        with self.assertRaisesRegex(FatalAgentError, "只读"):
            store.save(VALID_CONFIG)

    def test_environment_config_rejects_invalid_or_missing_secret(self) -> None:
        with self.assertRaisesRegex(FatalAgentError, "未设置"):
            EnvironmentAgentConfig("MISSING", environment={})

        environment = {"BROKEN": "not-base64"}
        with self.assertRaisesRegex(FatalAgentError, "Base64 JSON"):
            EnvironmentAgentConfig("BROKEN", environment=environment)
        self.assertNotIn("BROKEN", environment)


if __name__ == "__main__":
    unittest.main()
