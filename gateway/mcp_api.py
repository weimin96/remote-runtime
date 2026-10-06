from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import urlparse

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from remote_agent.core.limits import MAX_CONCURRENT_REQUESTS_PER_AGENT

from .agent_hub import AgentCommandError, AgentHub, AgentOfflineError
from .agent_protocol import (
    AGENT_PROTOCOL_VERSION,
    CURRENT_AGENT_VERSION,
    CURRENT_CORE_VERSION,
    agent_version_status,
)
from .config import Settings
from .database import Database
from .local_runtime import LocalCommandRuntime
from .profiles import (
    profile_action_mcp_tool,
    describe_profile_declarations,
    profile_names,
    validate_profile_result,
)
from .security import hash_token
from .shell_policy import describe_shell_policy, evaluate_shell_command


class GatewayTokenVerifier:
    def __init__(
        self,
        db: Database,
        resource: str,
        *,
        require_owner: bool,
        allow_mcp_keys: bool,
    ):
        self.db = db
        self.resource = resource
        self.require_owner = require_owner
        self.allow_mcp_keys = allow_mcp_keys

    async def verify_token(self, token: str) -> AccessToken | None:
        oauth = self.db.verify_oauth_access_token(hash_token(token))
        if oauth is not None:
            if self.require_owner and not self.db.is_owner(oauth["user_id"]):
                return None
            return AccessToken(
                token=token,
                client_id=oauth["client_id"],
                scopes=oauth["scopes"],
                subject=oauth["user_id"],
                resource=oauth["resource"],
                expires_at=oauth["expires_at"],
                claims={"user_id": oauth["user_id"], "email": oauth["email"]},
            )
        if not self.allow_mcp_keys:
            return None
        key = self.db.verify_mcp_key(hash_token(token))
        if key is None:
            return None
        if self.require_owner and not self.db.is_owner(key["user_id"]):
            return None
        return AccessToken(
            token=token,
            client_id=key["key_id"],
            scopes=["gateway:use"],
            subject=key["user_id"],
            resource=self.resource,
            claims={"user_id": key["user_id"], "email": key["email"]},
        )


def _current_identity() -> tuple[str, str | None]:
    access_token = get_access_token()
    if access_token is None or not access_token.subject:
        raise ToolError("MCP Access Key 无效")
    return access_token.subject, access_token.client_id


def _current_user_id() -> str:
    return _current_identity()[0]


def _patch_summary(patch: str) -> str:
    actions = [
        line.strip()
        for line in patch.splitlines()
        if line.startswith(("*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "))
    ]
    return "; ".join(actions[:20]) or "apply patch"


_AUDIT_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(password|passwd|token|secret|api[_-]?key|authorization)\s*=\s*([^\s]+)"
)
_AUDIT_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_AUDIT_URL_CREDENTIAL = re.compile(r"(://[^:/\s]+:)[^@/\s]+(@)")


def _command_summary(command: str) -> str:
    summary = _AUDIT_SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}=<redacted>", command)
    summary = _AUDIT_BEARER.sub("Bearer <redacted>", summary)
    summary = _AUDIT_URL_CREDENTIAL.sub(r"\1<redacted>\2", summary)
    return summary[:4000]


def _agent_summary(agent: dict[str, Any], hub: AgentHub) -> dict[str, Any]:
    result = {
        "id": agent["id"],
        "name": agent["name"],
        "description": agent["description"],
        "status": "online" if hub.is_online(agent["id"]) else "offline",
        "capabilities": profile_names(agent["profiles"]),
        "profile_declarations": agent["profile_declarations"],
        "requires_reenrollment": not agent["profile_declarations"],
        "version": agent["version"],
        "version_status": agent_version_status(agent["version"]),
        "last_seen_at": agent["last_seen_at"],
    }
    if "shell.v1" in agent["profiles"]:
        result["shell_policy"] = describe_shell_policy(agent["shell_policy_mode"])
    return result


def _shell_runtime(agent: dict[str, Any]) -> dict[str, Any] | None:
    for declaration in agent["profile_declarations"]:
        if declaration.get("id") == "shell.v1":
            runtime = declaration.get("runtime")
            return runtime if isinstance(runtime, dict) else None
    return None


def _owned_profile_action(
    db: Database,
    user_id: str,
    agent_id: str,
    profile_id: str,
    action: str,
    mcp_tool: str,
) -> dict[str, Any]:
    agent = db.get_owned_agent(user_id, agent_id)
    if agent is None:
        raise ToolError("Agent 不存在或不属于当前用户")
    if profile_id not in agent["profiles"]:
        raise ToolError(f"该 Agent 不支持 {profile_id}")
    try:
        declared_tool = profile_action_mcp_tool(profile_id, action)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    if declared_tool != mcp_tool:
        raise ToolError(f"{profile_id}/{action} 未映射到 {mcp_tool}")
    return agent


async def _execute_profile_action(
    *,
    db: Database,
    hub: AgentHub,
    user_id: str,
    agent_id: str,
    profile_id: str,
    action: str,
    mcp_tool: str,
    params: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    agent = _owned_profile_action(db, user_id, agent_id, profile_id, action, mcp_tool)
    if profile_id == "shell.v1" and action == "exec":
        violation = evaluate_shell_command(
            mode=agent["shell_policy_mode"],
            runtime=_shell_runtime(agent),
            command=str(params.get("command", "")),
        )
        if violation is not None:
            raise ToolError(violation.tool_error())
    try:
        result = await hub.execute(agent_id, profile_id, action, params, timeout)
    except (AgentOfflineError, AgentCommandError) as exc:
        raise ToolError(str(exc)) from exc
    try:
        return validate_profile_result(profile_id, action, result)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc


def create_mcp_server(
    db: Database,
    hub: AgentHub,
    settings: Settings,
    *,
    local_runtime: LocalCommandRuntime | None = None,
) -> FastMCP:
    parsed = urlparse(settings.public_url)
    resource_url = f"{settings.public_url}/mcp/"
    allowed_hosts = [parsed.netloc, "127.0.0.1:*", "localhost:*"]
    allowed_origins = [settings.public_url, "http://127.0.0.1:*", "http://localhost:*"]
    local_instructions = None
    if local_runtime is not None:
        roots = ", ".join(str(root) for root in local_runtime.allowed_workdirs)
        local_instructions = (
            "直接操作 Gateway 所在服务器。优先使用 exec_command 完成搜索、读取、Git、构建和系统命令；"
            "长时间运行的命令会返回 session_id，后续使用 write_stdin 继续读取输出或写入 stdin；"
            "修改文本文件优先使用 apply_patch。"
            f"允许的 Workspace Root: {roots}。"
            "需要快速定位项目时，如果 PATH 中存在 remote-project，优先使用 remote-project discover <root> 或 remote-project inspect <path> 获取工程类型、规则文件、Git 状态和建议命令；"
            "处理项目任务时，进入目标项目后先读取仓库内的 AGENTS.md/CLAUDE.md/README 等规则文件并检查 git status；"
            "修改后运行相关测试并检查 git diff，不要在用户未要求时自动 push。"
            "需要跨 Gateway 重启继续运行的交互任务或长构建时，如果目标主机安装了 tmux，可使用 exec_command(persistent=true)；"
            "真正需要跨主机 reboot 长期运行的服务，优先使用项目已有的 systemd、supervisor、pm2 或其他服务管理机制。"
        )
    server = FastMCP(
        "Remote Runtime",
        instructions=(
            local_instructions
            if local_runtime is not None
            else (
                "管理并操作当前用户拥有的远程 Agent。先调用 list_agents 选择目标设备；"
                "调用任何 Agent 专属工具前，必须先对目标 agent_id 调用 get_agent_capabilities。"
                "只有能力详情中的 Profile Action 明确列出当前工具的 mcp_tool 时才能调用，"
                "网关会在调用时再次校验。workspace.v1 覆盖已有文件或 edit 前必须先读取文件版本。"
                "若目标 Agent 启用了标准 Shell 拦截策略，部分系统级命令会在转发前被拒绝。"
            )
        ),
        token_verifier=GatewayTokenVerifier(
            db,
            resource_url,
            require_owner=local_runtime is not None,
            allow_mcp_keys=local_runtime is None,
        ),
        auth=AuthSettings(
            issuer_url=settings.public_url,
            resource_server_url=resource_url,
            required_scopes=["gateway:use"],
            validate_token_resource=True,
        ),
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=allowed_hosts,
            allowed_origins=allowed_origins,
        ),
        streamable_http_path="/",
        stateless_http=True,
        json_response=True,
    )

    if local_runtime is not None:
        @server.tool(
            title="执行服务器命令",
            description=(
                "在 Gateway 所在服务器运行 Shell 命令。POSIX 默认使用真实 PTY；短命令直接返回结果；"
                "命令超过 yield_time_ms 仍未结束时返回 session_id，可用 write_stdin 继续交互。"
                "cwd 必须位于配置的 Workspace Root 白名单下；不需要终端语义时可设置 tty=false。"
                "需要跨 Gateway 重启继续运行的任务可设置 persistent=true；该模式要求目标主机安装 tmux，"
                "输出为当前 pane 的 snapshot，仍使用 write_stdin 交互。"
            ),
            annotations=ToolAnnotations(
                readOnlyHint=False,
                destructiveHint=True,
                openWorldHint=True,
            ),
        )
        async def exec_command(
            cmd: str,
            ctx: Context,
            cwd: str | None = None,
            yield_time_ms: int = 10_000,
            max_output_chars: int = 50_000,
            tty: bool = True,
            columns: int = 120,
            rows: int = 30,
            persistent: bool = False,
        ) -> dict[str, object]:
            user_id, client_id = _current_identity()
            started = time.perf_counter()
            try:
                result = await local_runtime.exec_command(
                    user_id,
                    cmd,
                    cwd=cwd,
                    yield_time_ms=yield_time_ms,
                    max_output_chars=max_output_chars,
                    tty=tty,
                    columns=columns,
                    rows=rows,
                    persistent=persistent,
                )
                db.create_audit_log(
                    user_id=user_id,
                    client_id=client_id,
                    tool_name="exec_command",
                    action_summary=_command_summary(cmd),
                    cwd=cwd,
                    session_id=str(result["session_id"]) if result.get("session_id") else None,
                    exit_code=result.get("exit_code") if isinstance(result.get("exit_code"), int) else None,
                    success=True,
                    error=None,
                    duration_ms=int((time.perf_counter() - started) * 1000),
                    request_id=ctx.request_id,
                )
                return result
            except (ValueError, RuntimeError) as exc:
                db.create_audit_log(
                    user_id=user_id,
                    client_id=client_id,
                    tool_name="exec_command",
                    action_summary=_command_summary(cmd),
                    cwd=cwd,
                    session_id=None,
                    exit_code=None,
                    success=False,
                    error=str(exc),
                    duration_ms=int((time.perf_counter() - started) * 1000),
                    request_id=ctx.request_id,
                )
                raise ToolError(str(exc)) from exc

        @server.tool(
            title="继续服务器命令会话",
            description=(
                "向 exec_command 返回的运行中 session 写入字符，或在 chars 为空时轮询增量输出。"
                "发送 \\u0003 可中断当前进程组；PTY/tmux 会话可通过 columns/rows 调整终端尺寸。"
                "persistent session 可以在 Gateway 进程重启后继续使用。"
            ),
            annotations=ToolAnnotations(
                readOnlyHint=False,
                destructiveHint=True,
                openWorldHint=True,
            ),
        )
        async def write_stdin(
            session_id: str,
            ctx: Context,
            chars: str = "",
            yield_time_ms: int | None = None,
            max_output_chars: int = 50_000,
            columns: int | None = None,
            rows: int | None = None,
        ) -> dict[str, object]:
            user_id, client_id = _current_identity()
            started = time.perf_counter()
            summary = "interrupt" if chars == "\x03" else (f"write {len(chars)} chars" if chars else "poll")
            try:
                result = await local_runtime.write_stdin(
                    user_id,
                    session_id,
                    chars=chars,
                    yield_time_ms=yield_time_ms,
                    max_output_chars=max_output_chars,
                    columns=columns,
                    rows=rows,
                )
                db.create_audit_log(
                    user_id=user_id,
                    client_id=client_id,
                    tool_name="write_stdin",
                    action_summary=summary,
                    cwd=None,
                    session_id=session_id,
                    exit_code=result.get("exit_code") if isinstance(result.get("exit_code"), int) else None,
                    success=True,
                    error=None,
                    duration_ms=int((time.perf_counter() - started) * 1000),
                    request_id=ctx.request_id,
                )
                return result
            except (ValueError, RuntimeError) as exc:
                db.create_audit_log(
                    user_id=user_id,
                    client_id=client_id,
                    tool_name="write_stdin",
                    action_summary=summary,
                    cwd=None,
                    session_id=session_id,
                    exit_code=None,
                    success=False,
                    error=str(exc),
                    duration_ms=int((time.perf_counter() - started) * 1000),
                    request_id=ctx.request_id,
                )
                raise ToolError(str(exc)) from exc

        @server.tool(
            title="应用服务器文件补丁",
            description=(
                "在配置的 Workspace Root 白名单内应用 Codex 风格文本补丁。"
                "cwd 可选择目标项目目录；支持 *** Add File、*** Update File、*** Delete File 和 *** Move to。"
            ),
            annotations=ToolAnnotations(
                readOnlyHint=False,
                destructiveHint=True,
                openWorldHint=False,
            ),
        )
        async def apply_patch(
            patch: str,
            ctx: Context,
            cwd: str | None = None,
        ) -> dict[str, object]:
            user_id, client_id = _current_identity()
            started = time.perf_counter()
            summary = _patch_summary(patch)
            try:
                result = local_runtime.apply_patch(patch, cwd=cwd)
                db.create_audit_log(
                    user_id=user_id,
                    client_id=client_id,
                    tool_name="apply_patch",
                    action_summary=summary,
                    cwd=str(result["cwd"]),
                    session_id=None,
                    exit_code=None,
                    success=True,
                    error=None,
                    duration_ms=int((time.perf_counter() - started) * 1000),
                    request_id=ctx.request_id,
                )
                return result
            except ValueError as exc:
                db.create_audit_log(
                    user_id=user_id,
                    client_id=client_id,
                    tool_name="apply_patch",
                    action_summary=summary,
                    cwd=cwd or str(local_runtime.workdir),
                    session_id=None,
                    exit_code=None,
                    success=False,
                    error=str(exc),
                    duration_ms=int((time.perf_counter() - started) * 1000),
                    request_id=ctx.request_id,
                )
                raise ToolError(str(exc)) from exc

        return server

    @server.tool(
        description="列出当前用户拥有的远程 Agent，包括用途、在线状态和可用能力。"
    )
    async def list_agents(ctx: Context) -> dict[str, Any]:
        del ctx
        user_id = _current_user_id()
        agents = db.list_agents(user_id)
        return {"agents": [_agent_summary(agent, hub) for agent in agents]}

    @server.tool(
        description=(
            "查询指定 Agent 的标准能力、可用操作、限制及每个操作对应的固定 MCP 工具。"
            "调用任何 Agent 专属工具前必须先调用它确认能力和调用入口；"
            "不要仅根据 tools/list 推断某个 Agent 支持哪些能力。"
        )
    )
    async def get_agent_capabilities(agent_id: str, ctx: Context) -> dict[str, Any]:
        del ctx
        user_id = _current_user_id()
        agent = db.get_owned_agent(user_id, agent_id)
        if agent is None:
            raise ToolError("Agent 不存在或不属于当前用户")
        return {
            "agent": _agent_summary(agent, hub),
            "profiles": describe_profile_declarations(agent["profile_declarations"]),
            "gateway_limits": {
                "max_command_timeout_seconds": settings.max_command_timeout,
                "max_concurrent_requests_per_agent": MAX_CONCURRENT_REQUESTS_PER_AGENT,
            },
            "current_agent_release": {
                "agent_version": CURRENT_AGENT_VERSION,
                "core_version": CURRENT_CORE_VERSION,
                "protocol_version": AGENT_PROTOCOL_VERSION,
            },
        }

    @server.tool(
        description=(
            "在指定在线 Agent 上执行 Shell 命令，并返回 stdout、stderr 和 exit_code。"
            "调用前必须先对该 agent_id 调用 get_agent_capabilities；"
            "只有 Agent 声明了 shell.v1，且 shell.v1/exec 的 mcp_tool 明确为 remote_exec 时才能调用，"
            "网关会再次校验。"
            "command 必须符合 get_agent_capabilities 返回的 Shell 方言。"
            "该能力拥有 Agent 所在系统账号的完整 Shell 权限。"
            "目标 Agent 启用标准命令策略时，网关会在执行前拦截部分系统级高风险操作。"
        )
    )
    async def remote_exec(
        agent_id: str,
        command: str,
        ctx: Context,
        timeout: int = 300,
    ) -> dict[str, Any]:
        del ctx
        user_id = _current_user_id()
        if not command.strip():
            raise ToolError("command 不能为空")
        if timeout < 1 or timeout > settings.max_command_timeout:
            raise ToolError(f"timeout 必须在 1 到 {settings.max_command_timeout} 秒之间")
        return await _execute_profile_action(
            db=db,
            hub=hub,
            user_id=user_id,
            agent_id=agent_id,
            profile_id="shell.v1",
            action="exec",
            mcp_tool="remote_exec",
            params={"command": command, "timeout": timeout},
            timeout=timeout,
        )

    @server.tool(
        description=(
            "读取指定在线 Agent 工作目录内的 UTF-8 文本文件。"
            "调用前必须先对该 agent_id 调用 get_agent_capabilities；"
            "只有 Agent 声明 workspace.v1 且 workspace.v1/read 的 mcp_tool 为 remote_read_file 时才能调用。"
            "path 必须是工作目录下的相对路径，返回内容可能因行数或字节上限被截断，并包含 sha256。"
        )
    )
    async def remote_read_file(
        agent_id: str,
        path: str,
        ctx: Context,
        offset: int = 1,
        limit: int = 2000,
    ) -> dict[str, Any]:
        del ctx
        user_id = _current_user_id()
        return await _execute_profile_action(
            db=db,
            hub=hub,
            user_id=user_id,
            agent_id=agent_id,
            profile_id="workspace.v1",
            action="read",
            mcp_tool="remote_read_file",
            params={"path": path, "offset": offset, "limit": limit},
            timeout=min(settings.max_command_timeout, 60),
        )

    @server.tool(
        description=(
            "在指定在线 Agent 工作目录内整体写入 UTF-8 文本文件。"
            "调用前必须先对该 agent_id 调用 get_agent_capabilities；"
            "只有 Agent 声明 workspace.v1 且 workspace.v1/write 的 mcp_tool 为 remote_write_file 时才能调用。"
            "path 必须是工作目录下的相对路径。expected_sha256 必须显式提供："
            "传 null 时只允许新建，传最近一次读取的 SHA-256 时只允许覆盖该版本。"
        )
    )
    async def remote_write_file(
        agent_id: str,
        path: str,
        content: str,
        expected_sha256: str | None,
        ctx: Context,
    ) -> dict[str, Any]:
        del ctx
        user_id = _current_user_id()
        return await _execute_profile_action(
            db=db,
            hub=hub,
            user_id=user_id,
            agent_id=agent_id,
            profile_id="workspace.v1",
            action="write",
            mcp_tool="remote_write_file",
            params={
                "path": path,
                "content": content,
                "expected_sha256": expected_sha256,
            },
            timeout=min(settings.max_command_timeout, 60),
        )

    @server.tool(
        description=(
            "在指定在线 Agent 工作目录内精确编辑 UTF-8 文本文件。"
            "调用前必须先对该 agent_id 调用 get_agent_capabilities 和 remote_read_file；"
            "只有 Agent 声明 workspace.v1 且 workspace.v1/edit 的 mcp_tool 为 remote_edit_file 时才能调用。"
            "old_text 必须恰好匹配一次，expected_sha256 必须来自最近一次读取；冲突时不会覆盖文件。"
        )
    )
    async def remote_edit_file(
        agent_id: str,
        path: str,
        old_text: str,
        new_text: str,
        expected_sha256: str,
        ctx: Context,
    ) -> dict[str, Any]:
        del ctx
        user_id = _current_user_id()
        return await _execute_profile_action(
            db=db,
            hub=hub,
            user_id=user_id,
            agent_id=agent_id,
            profile_id="workspace.v1",
            action="edit",
            mcp_tool="remote_edit_file",
            params={
                "path": path,
                "old_text": old_text,
                "new_text": new_text,
                "expected_sha256": expected_sha256,
            },
            timeout=min(settings.max_command_timeout, 60),
        )

    return server
