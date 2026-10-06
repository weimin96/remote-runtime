from __future__ import annotations

import ctypes
import os
import platform
from pathlib import Path


def is_elevated() -> bool:
    if platform.system().lower() == "windows":
        try:
            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except (AttributeError, OSError):
            return False
    get_effective_user_id = getattr(os, "geteuid", None)
    return callable(get_effective_user_id) and get_effective_user_id() == 0


def privileged_shell_warning(profile_ids: list[str], workdir: Path) -> str | None:
    if "shell.v1" not in profile_ids or not is_elevated():
        return None
    return (
        "安全警告: shell.v1 正由 root/管理员账号运行，将继承该账号的完整系统权限。"
        f"当前 --workdir 为 {workdir}，它只约束 workspace.v1，不能限制 Shell。"
        "生产环境请改用无 sudo/管理员权限的专用系统账号或非 root 容器。"
    )
