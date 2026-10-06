from __future__ import annotations

import argparse
import asyncio
import os
import socket
import sys
from pathlib import Path

from remote_agent.core import (
    AgentConfig,
    EnvironmentAgentConfig,
    FatalAgentError,
    RemoteAgent,
    load_manifest,
    privileged_shell_warning,
)
from remote_agent.profiles import build_profile_handlers


def parse_args(default_config: Path | None = None) -> argparse.Namespace:
    config_path = default_config or (Path.home() / ".remote-agent" / "config.json")
    parser = argparse.ArgumentParser(description="Remote Runtime 远程 Agent")
    parser.add_argument("--gateway", help="Agent WebSocket 地址，例如 ws://127.0.0.1:8000/ws/agent")
    token_group = parser.add_mutually_exclusive_group()
    token_group.add_argument("--token", help="首次注册使用的一次性 Enrollment Token")
    token_group.add_argument(
        "--token-file",
        type=Path,
        help="从文件读取一次性 Enrollment Token；读取后立即删除该文件",
    )
    parser.add_argument("--name", help="Agent 显示名称，默认读取 Manifest 或主机名")
    parser.add_argument("--description", help="Agent 用途描述，默认读取 Manifest")
    parser.add_argument("--workdir", default=os.getcwd(), help="远程命令工作目录")
    parser.add_argument(
        "--enroll-only",
        action="store_true",
        help="只完成首次注册并保存设备凭据，然后退出；供安装器使用",
    )
    config_group = parser.add_mutually_exclusive_group()
    config_group.add_argument(
        "--config", type=Path, default=config_path, help="设备凭据保存位置"
    )
    config_group.add_argument(
        "--config-env",
        metavar="NAME",
        help=(
            "从指定环境变量读取 Base64 JSON 设备凭据；适用于 CI、容器和只读环境"
        ),
    )
    parser.add_argument("--manifest", type=Path, help="Agent 组装 Manifest，默认读取包内 manifest.json")
    return parser.parse_args()


def _consume_token_file(path: Path) -> str:
    resolved = path.expanduser().resolve()
    try:
        token = resolved.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise FatalAgentError(f"无法读取 Enrollment Token 文件: {resolved}") from exc
    if not token:
        raise FatalAgentError(f"Enrollment Token 文件为空: {resolved}")
    try:
        resolved.unlink()
    except OSError as exc:
        raise FatalAgentError(
            f"读取后无法删除 Enrollment Token 文件: {resolved}。"
            "为避免一次性凭据残留，已中止注册。"
        ) from exc
    return token


async def async_main(default_config: Path | None = None) -> None:
    args = parse_args(default_config)
    manifest = load_manifest(args.manifest)
    config_store = (
        EnvironmentAgentConfig(args.config_env)
        if args.config_env
        else AgentConfig(args.config)
    )
    if args.token_file and config_store.load() is not None:
        raise FatalAgentError(
            "该配置已经绑定 Agent，不能再次使用 --token-file。"
            "Token 文件保持原样，未读取也未删除。"
        )
    enrollment_token = (
        _consume_token_file(args.token_file)
        if args.token_file
        else args.token.strip() if args.token else None
    )
    if args.enroll_only and not enrollment_token:
        raise FatalAgentError("--enroll-only 只能与 --token 或 --token-file 一起用于首次注册")
    saved = config_store.prepare_startup(enrollment_token)
    gateway_url = args.gateway or (saved or {}).get("gateway_url")
    if not gateway_url:
        raise FatalAgentError("需要通过 --gateway 指定网关 WebSocket 地址")
    workdir = Path(args.workdir).expanduser().resolve()
    if not workdir.is_dir():
        raise FatalAgentError(f"工作目录不存在: {workdir}")
    handlers = build_profile_handlers(manifest.profiles, workdir)
    warning = privileged_shell_warning(manifest.profiles, workdir)
    if warning:
        print(warning, file=sys.stderr, flush=True)
    agent = RemoteAgent(
        gateway_url=gateway_url,
        config_store=config_store,
        enrollment_token=enrollment_token,
        name=(args.name.strip() if args.name else manifest.name) or socket.gethostname(),
        description=args.description.strip() if args.description is not None else manifest.description,
        build_id=manifest.build_id,
        handlers=handlers,
    )
    if args.enroll_only:
        await agent.enroll_once()
    else:
        await agent.run_forever()


def main(default_config: Path | None = None) -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    try:
        asyncio.run(async_main(default_config))
    except FatalAgentError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
    except KeyboardInterrupt:
        pass
