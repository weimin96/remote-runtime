from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


SHELL_POLICY_MODES = ("off", "standard")

POLICY_MODES = (
    {
        "id": "off",
        "name": "关闭拦截",
        "description": "命令直接转发给 Agent，保持 shell.v1 的原有行为。",
    },
    {
        "id": "standard",
        "name": "标准拦截",
        "description": "拦截少量明确的系统级高风险操作，不限制普通文件删除和开发命令。",
    },
)

STANDARD_RULES = (
    {
        "id": "disk_management",
        "name": "磁盘管理",
        "description": "格式化、分区、清空磁盘或向原始设备写入数据。",
    },
    {
        "id": "system_power",
        "name": "系统电源",
        "description": "关机、重启或休眠系统。",
    },
    {
        "id": "privilege_escalation",
        "name": "权限提升",
        "description": "请求或启动更高权限的执行上下文。",
    },
    {
        "id": "credential_store_access",
        "name": "系统凭据",
        "description": "读取系统密码库、SSH 私钥或系统账户密码文件。",
    },
    {
        "id": "persistence",
        "name": "持久化入口",
        "description": "创建计划任务、系统服务或开机自启动项。",
    },
    {
        "id": "security_controls",
        "name": "安全防护",
        "description": "关闭系统安全防护或防火墙。",
    },
)


@dataclass(frozen=True, slots=True)
class ShellPolicyViolation:
    rule_id: str
    message: str

    def tool_error(self) -> str:
        return f"command_blocked [{self.rule_id}]: {self.message}"


_RULE_MESSAGES = {rule["id"]: rule["description"] for rule in STANDARD_RULES}
_COMMAND_BOUNDARY = r"(?:^|(?:&&?|\|\|?|;)\s*)"
_FLAGS = re.IGNORECASE | re.MULTILINE


def _patterns(*values: str) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(value, _FLAGS) for value in values)


_COMMON_RULES: dict[str, tuple[re.Pattern[str], ...]] = {
    "disk_management": _patterns(
        rf"{_COMMAND_BOUNDARY}(?:mkfs(?:\.[a-z0-9_-]+)?|fdisk|sfdisk|cfdisk|parted|wipefs|diskutil)\b",
        rf"{_COMMAND_BOUNDARY}dd\b[^\r\n]*\bof\s*=\s*/dev/",
    ),
    "system_power": _patterns(
        rf"{_COMMAND_BOUNDARY}(?:shutdown|reboot|poweroff|halt)\b",
        rf"{_COMMAND_BOUNDARY}(?:systemctl|loginctl)\s+(?:reboot|poweroff|halt)\b",
    ),
    "privilege_escalation": _patterns(
        rf"{_COMMAND_BOUNDARY}(?:sudo|su|doas|pkexec)\b",
    ),
    "credential_store_access": _patterns(
        r"(?:^|[\\/])etc[\\/](?:shadow|gshadow|master\.passwd)\b",
        r"\.ssh[\\/](?:id_(?:rsa|dsa|ecdsa|ed25519)|id_[a-z0-9_.-]+)(?!\.pub)\b",
        r"\.aws[\\/]credentials\b",
        rf"{_COMMAND_BOUNDARY}(?:security\s+find-(?:generic|internet)-password|secret-tool\s+lookup)\b",
    ),
    "persistence": _patterns(
        rf"{_COMMAND_BOUNDARY}crontab\b(?!\s+-l\b)",
        rf"{_COMMAND_BOUNDARY}systemctl\s+enable\b",
        rf"{_COMMAND_BOUNDARY}launchctl\s+(?:load|bootstrap)\b",
    ),
    "security_controls": _patterns(
        rf"{_COMMAND_BOUNDARY}ufw\s+disable\b",
        rf"{_COMMAND_BOUNDARY}(?:systemctl|service)\s+(?:stop|disable)\s+(?:ufw|firewalld|apparmor)\b",
    ),
}

_DIALECT_RULES: dict[str, dict[str, tuple[re.Pattern[str], ...]]] = {
    "powershell": {
        "disk_management": _patterns(
            rf"{_COMMAND_BOUNDARY}(?:Clear-Disk|Format-Volume|Initialize-Disk|Remove-Partition|Set-Partition)\b",
        ),
        "system_power": _patterns(
            rf"{_COMMAND_BOUNDARY}(?:Stop-Computer|Restart-Computer|Suspend-Computer)\b",
        ),
        "privilege_escalation": _patterns(
            rf"{_COMMAND_BOUNDARY}runas\b",
            r"\bStart-Process\b[^\r\n]*\b-Verb\s+RunAs\b",
        ),
        "credential_store_access": _patterns(
            rf"{_COMMAND_BOUNDARY}(?:cmdkey|vaultcmd|Get-StoredCredential)\b",
        ),
        "persistence": _patterns(
            rf"{_COMMAND_BOUNDARY}(?:New-ScheduledTask|Register-ScheduledTask|New-Service)\b",
            r"\b(?:New-ItemProperty|Set-ItemProperty|reg(?:\.exe)?)\b[^\r\n]*\\(?:CurrentVersion\\)?Run(?:Once)?\b",
        ),
        "security_controls": _patterns(
            rf"{_COMMAND_BOUNDARY}Set-MpPreference\b[^\r\n]*-Disable[a-z]+\b",
            rf"{_COMMAND_BOUNDARY}Set-NetFirewallProfile\b[^\r\n]*-Enabled\s+(?:\$?false|0)\b",
            rf"{_COMMAND_BOUNDARY}netsh\s+advfirewall\b[^\r\n]*\b(?:off|disable)\b",
        ),
    },
    "cmd": {
        "disk_management": _patterns(
            rf"{_COMMAND_BOUNDARY}(?:format|diskpart)\b",
            rf"{_COMMAND_BOUNDARY}dd\b[^\r\n]*\bof\s*=\s*\\\\\.\\PhysicalDrive",
        ),
        "system_power": _patterns(rf"{_COMMAND_BOUNDARY}shutdown\b"),
        "privilege_escalation": _patterns(rf"{_COMMAND_BOUNDARY}runas\b"),
        "credential_store_access": _patterns(rf"{_COMMAND_BOUNDARY}(?:cmdkey|vaultcmd)\b"),
        "persistence": _patterns(
            rf"{_COMMAND_BOUNDARY}schtasks\b[^\r\n]*\s/create\b",
            rf"{_COMMAND_BOUNDARY}sc(?:\.exe)?\s+create\b",
            r"\breg(?:\.exe)?\s+add\b[^\r\n]*\\(?:CurrentVersion\\)?Run(?:Once)?\b",
        ),
        "security_controls": _patterns(
            rf"{_COMMAND_BOUNDARY}netsh\s+advfirewall\b[^\r\n]*\b(?:off|disable)\b",
        ),
    },
    "posix-sh": {},
}


def validate_shell_policy_mode(value: object) -> str:
    if not isinstance(value, str) or value not in SHELL_POLICY_MODES:
        raise ValueError("shell_policy_mode 无效")
    return value


def describe_shell_policy(mode: object) -> dict[str, Any]:
    normalized = validate_shell_policy_mode(mode)
    return {
        "mode": normalized,
        "modes": [dict(item) for item in POLICY_MODES],
        "rules": [dict(item) for item in STANDARD_RULES],
    }


def evaluate_shell_command(
    *, mode: object, runtime: object, command: str
) -> ShellPolicyViolation | None:
    normalized_mode = validate_shell_policy_mode(mode)
    if normalized_mode == "off":
        return None
    if not isinstance(runtime, dict) or not isinstance(runtime.get("dialect"), str):
        return ShellPolicyViolation("policy_unavailable", "Agent 未声明可用于策略判断的 Shell 方言")

    dialect = runtime["dialect"]
    dialect_rules = _DIALECT_RULES.get(dialect)
    if dialect_rules is None:
        return ShellPolicyViolation("policy_unavailable", f"不支持的 Shell 方言: {dialect}")

    for rule in STANDARD_RULES:
        rule_id = rule["id"]
        patterns = _COMMON_RULES.get(rule_id, ()) + dialect_rules.get(rule_id, ())
        if any(pattern.search(command) for pattern in patterns):
            return ShellPolicyViolation(rule_id, _RULE_MESSAGES[rule_id])
    return None
