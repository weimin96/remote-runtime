from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class Settings:
    host: str
    port: int
    public_url: str
    data_dir: Path
    database_path: Path
    session_days: int
    enrollment_minutes: int
    max_command_timeout: int
    secure_cookies: bool
    local_workdir: Path | None = None
    local_workdirs: tuple[Path, ...] = ()
    local_exec_user: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        public_url = os.getenv("GATEWAY_PUBLIC_URL", "http://127.0.0.1:8000").rstrip("/")
        host = os.getenv("GATEWAY_HOST", "127.0.0.1")
        data_dir = Path(os.getenv("GATEWAY_DATA_DIR", "data")).resolve()
        database_path = Path(os.getenv("GATEWAY_DATABASE", str(data_dir / "gateway.db"))).resolve()
        parsed = urlparse(public_url)
        local_workdir = (
            Path(value).expanduser().resolve()
            if (value := os.getenv("GATEWAY_LOCAL_WORKDIR", "").strip())
            else None
        )
        extra_workdirs_raw = os.getenv("GATEWAY_LOCAL_WORKDIRS", "").strip()
        if extra_workdirs_raw and local_workdir is None:
            raise ValueError("GATEWAY_LOCAL_WORKDIRS 需要同时设置主 GATEWAY_LOCAL_WORKDIR")
        local_workdirs: tuple[Path, ...] = ()
        if local_workdir is not None:
            roots = [local_workdir]
            roots.extend(
                Path(value.strip()).expanduser().resolve()
                for value in extra_workdirs_raw.split(os.pathsep)
                if value.strip()
            )
            local_workdirs = tuple(dict.fromkeys(roots))
        local_exec_user = os.getenv("GATEWAY_LOCAL_EXEC_USER", "").strip() or None
        secure_cookies = _env_bool("GATEWAY_SECURE_COOKIES", parsed.scheme == "https")
        if local_workdir is not None:
            localhost = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            if host not in {"127.0.0.1", "localhost", "::1"}:
                raise ValueError(
                    "本机执行模式必须将 GATEWAY_HOST 绑定到 loopback，并通过反向代理提供公网 HTTPS"
                )
            if parsed.scheme != "https" and not localhost:
                raise ValueError("本机执行模式的公网 GATEWAY_PUBLIC_URL 必须使用 HTTPS")
            if parsed.scheme == "https" and not secure_cookies:
                raise ValueError("本机执行模式使用 HTTPS 时必须启用 GATEWAY_SECURE_COOKIES")
            if not localhost and not local_exec_user:
                raise ValueError(
                    "公网本机执行模式必须设置 GATEWAY_LOCAL_EXEC_USER，"
                    "让命令执行用户与 Gateway 控制面用户隔离"
                )
        return cls(
            host=host,
            port=int(os.getenv("GATEWAY_PORT", "8000")),
            public_url=public_url,
            data_dir=data_dir,
            database_path=database_path,
            session_days=int(os.getenv("GATEWAY_SESSION_DAYS", "30")),
            enrollment_minutes=int(os.getenv("GATEWAY_ENROLLMENT_MINUTES", "30")),
            max_command_timeout=int(os.getenv("GATEWAY_MAX_COMMAND_TIMEOUT", "3600")),
            secure_cookies=secure_cookies,
            local_workdir=local_workdir,
            local_workdirs=local_workdirs,
            local_exec_user=local_exec_user,
        )

    @property
    def websocket_url(self) -> str:
        parsed = urlparse(self.public_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return f"{scheme}://{parsed.netloc}/ws/agent"

    @property
    def bundles_dir(self) -> Path:
        return self.data_dir / "bundles"
