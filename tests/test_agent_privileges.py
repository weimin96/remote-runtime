from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from remote_agent.core.privileges import privileged_shell_warning


class AgentPrivilegeTests(unittest.TestCase):
    def test_elevated_shell_warns_that_workdir_is_not_a_shell_boundary(self) -> None:
        with patch("remote_agent.core.privileges.is_elevated", return_value=True):
            warning = privileged_shell_warning(["shell.v1", "workspace.v1"], Path("/srv/work"))
        self.assertIn("root/管理员", warning)
        self.assertIn("只约束 workspace.v1", warning)
        self.assertIn("专用系统账号", warning)

    def test_workspace_only_or_non_elevated_agent_does_not_warn(self) -> None:
        with patch("remote_agent.core.privileges.is_elevated", return_value=True):
            self.assertIsNone(privileged_shell_warning(["workspace.v1"], Path("/srv/work")))
        with patch("remote_agent.core.privileges.is_elevated", return_value=False):
            self.assertIsNone(privileged_shell_warning(["shell.v1"], Path("/srv/work")))


if __name__ == "__main__":
    unittest.main()
