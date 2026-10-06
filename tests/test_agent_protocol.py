from __future__ import annotations

import unittest

from gateway.agent_protocol import (
    CURRENT_AGENT_VERSION,
    CURRENT_CORE_VERSION,
    agent_version_status,
    validate_agent_version,
)


class AgentVersionTests(unittest.TestCase):
    def test_version_declaration_is_validated(self) -> None:
        version = validate_agent_version(
            {
                "agent_version": "0.1.0",
                "core_version": 1,
                "protocol_version": 2,
                "build_id": "bundle-1234",
            },
            2,
        )
        self.assertEqual(version["build_id"], "bundle-1234")

        with self.assertRaisesRegex(ValueError, "握手协议版本不一致"):
            validate_agent_version(
                {
                    "agent_version": "0.1.0",
                    "core_version": 1,
                    "protocol_version": 1,
                    "build_id": "bundle-1234",
                },
                2,
            )

    def test_version_status_distinguishes_upgrade_and_incompatibility(self) -> None:
        self.assertEqual(
            agent_version_status(
                {
                    "agent_version": CURRENT_AGENT_VERSION,
                    "core_version": CURRENT_CORE_VERSION,
                    "protocol_version": 2,
                    "build_id": "current",
                }
            ),
            "current",
        )
        self.assertEqual(
            agent_version_status(
                {
                    "agent_version": "0.1.0",
                    "core_version": 1,
                    "protocol_version": 2,
                    "build_id": "old",
                }
            ),
            "update_available",
        )
        self.assertEqual(
            agent_version_status(
                {
                    "agent_version": CURRENT_AGENT_VERSION,
                    "core_version": CURRENT_CORE_VERSION,
                    "protocol_version": 1,
                    "build_id": "incompatible",
                }
            ),
            "incompatible",
        )
        self.assertEqual(agent_version_status({}), "unknown")


if __name__ == "__main__":
    unittest.main()
