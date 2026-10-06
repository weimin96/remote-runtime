from __future__ import annotations

from typing import Any

from remote_agent.profiles.base import ProfileContext, ProfileHandler

from .actions import EditAction, ReadAction, WriteAction
from .constants import MAX_FILE_BYTES


class WorkspaceV1Profile(ProfileHandler):
    profile_id = "workspace.v1"

    def __init__(self, context: ProfileContext):
        super().__init__(
            context,
            {
                "read": ReadAction(context.workdir),
                "write": WriteAction(context.workdir),
                "edit": EditAction(context.workdir),
            },
        )

    def runtime_metadata(self) -> dict[str, Any]:
        return {
            "scope": "workdir",
            "path_format": "relative-posix",
            "encoding": "utf-8",
            "max_file_bytes": MAX_FILE_BYTES,
        }
