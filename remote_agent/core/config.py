from __future__ import annotations

import base64
import binascii
import json
import os
import secrets
from collections.abc import MutableMapping
from pathlib import Path
from typing import Any, Protocol

from .errors import FatalAgentError


def _validate_device_config(value: object, source: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise FatalAgentError(f"设备凭据格式无效: {source}")
    for field in ("gateway_url", "agent_id", "credential"):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise FatalAgentError(f"设备凭据缺少有效的 {field}: {source}")
    return value


class AgentConfigStore(Protocol):
    def load(self) -> dict[str, Any] | None: ...

    def prepare_startup(self, enrollment_token: str | None) -> dict[str, Any] | None: ...

    def save(self, value: dict[str, Any]) -> None: ...


class AgentConfig:
    def __init__(self, path: Path):
        self.path = path.expanduser().resolve()

    def load(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        if not self.path.is_file():
            raise FatalAgentError(f"设备凭据路径不是文件: {self.path}")
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                value = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            raise FatalAgentError(f"无法读取设备凭据: {self.path}") from exc
        return _validate_device_config(value, str(self.path))

    def prepare_startup(self, enrollment_token: str | None) -> dict[str, Any] | None:
        saved = self.load()
        if saved is not None:
            if enrollment_token:
                raise FatalAgentError(
                    f"该配置路径已经绑定 Agent，不能再次使用 Enrollment Token: {self.path}。"
                    "启动现有 Agent 请移除 --token；注册新 Agent 请指定新的 --config 路径。"
                )
            return saved
        if not enrollment_token:
            raise FatalAgentError(
                "首次运行需要提供 --token，或通过 --config 指向已有设备凭据"
            )
        self._ensure_writable()
        return None

    def _temporary_path(self, purpose: str) -> Path:
        return self.path.with_name(
            f".{self.path.name}.{secrets.token_hex(8)}.{purpose}"
        )

    def _ensure_writable(self) -> None:
        temporary = self._temporary_path("write-test")
        replacement = self._temporary_path("replace-test")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with temporary.open("x", encoding="utf-8") as handle:
                handle.write("{}\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, replacement)
        except OSError as exc:
            raise FatalAgentError(
                f"设备凭据位置不可写: {self.path}。"
                "请通过 --config 指向可写且可持久化的位置。"
            ) from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
                replacement.unlink(missing_ok=True)
            except OSError:
                pass

    def save(self, value: dict[str, Any]) -> None:
        temporary = self._temporary_path("tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with temporary.open("x", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            if os.name != "nt":
                os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        except OSError as exc:
            raise FatalAgentError(
                f"无法保存设备凭据: {self.path}。"
                "Enrollment Token 可能已经被消费，请修复存储位置后重新签发 Token。"
            ) from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


class EnvironmentAgentConfig:
    """Read-only device credentials supplied by a process environment variable."""

    def __init__(
        self,
        variable_name: str,
        environment: MutableMapping[str, str] | None = None,
    ):
        normalized = variable_name.strip()
        if not normalized:
            raise FatalAgentError("设备凭据环境变量名称不能为空")
        self.variable_name = normalized
        source = environment if environment is not None else os.environ

        # Consume the secret before Profile handlers can spawn child processes.
        # In particular, shell.v1 must not be able to read its own credential.
        encoded = source.pop(normalized, None)
        if not isinstance(encoded, str) or not encoded.strip():
            raise FatalAgentError(f"设备凭据环境变量未设置: {normalized}")
        compact = "".join(encoded.split())
        try:
            raw = base64.b64decode(compact, validate=True).decode("utf-8")
            value = json.loads(raw)
        except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise FatalAgentError(
                f"设备凭据环境变量不是有效的 Base64 JSON: {normalized}"
            ) from exc
        self._value = _validate_device_config(value, f"环境变量 {normalized}")

    def load(self) -> dict[str, Any]:
        return dict(self._value)

    def prepare_startup(self, enrollment_token: str | None) -> dict[str, Any]:
        if enrollment_token:
            raise FatalAgentError(
                "环境变量凭据模式不能使用 Enrollment Token；"
                "请先完成一次注册，再把已生成的设备凭据保存到 CI Secret"
            )
        return self.load()

    def save(self, value: dict[str, Any]) -> None:
        del value
        raise FatalAgentError("环境变量设备凭据为只读配置，不能写回")
