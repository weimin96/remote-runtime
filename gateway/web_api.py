import shlex
import time
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from .agent_builder import AgentBuildError, PythonAgentBuilder, new_bundle_id
from .agent_hub import AgentHub
from .agent_protocol import agent_version_status
from .config import Settings
from .database import ConflictError, Database
from .mfa import verify_owner_mfa_code
from .profiles import (
    describe_profile_declarations,
    profile_names,
    public_profile_catalog,
    validate_profiles,
)
from .rate_limit import RateLimitExceeded, RateLimiter, client_key
from .security import IssuedToken, hash_password, hash_token, issue_token, verify_password
from .shell_policy import describe_shell_policy


SESSION_COOKIE = "remote_gateway_session"


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=128)
    mfa_code: str | None = Field(default=None, max_length=64)


class NamedItem(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class AgentUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)


class ShellPolicyUpdate(BaseModel):
    mode: Literal["off", "standard"]


class AgentBundleRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    runtime: str = Field(default="python", max_length=32)
    profiles: list[str] = Field(min_length=1, max_length=16)


def _normalize_email(email: str) -> str:
    normalized = email.strip().lower()
    if normalized.count("@") != 1 or normalized.startswith("@") or normalized.endswith("@"):
        raise HTTPException(status_code=422, detail="请输入有效的邮箱地址")
    return normalized


def _agent_view(agent: dict[str, Any], hub: AgentHub) -> dict[str, Any]:
    result = dict(agent)
    result["online"] = hub.is_online(agent["id"])
    result["capabilities"] = profile_names(agent["profiles"])
    result["requires_reenrollment"] = not agent["profile_declarations"]
    result["version_status"] = agent_version_status(agent["version"])
    if result["requires_reenrollment"]:
        result["lifecycle_status"] = "reenroll_required"
    elif result["version_status"] in {"update_available", "incompatible"}:
        result["lifecycle_status"] = "upgrade_available"
    else:
        result["lifecycle_status"] = result["version_status"]
    result["managed_upgrade_command"] = "sudo remote-runtime-agent-upgrade"
    result["shell_policy"] = (
        describe_shell_policy(agent["shell_policy_mode"])
        if "shell.v1" in agent["profiles"]
        else None
    )
    return result


def _enforce_rate_limit(
    limiter: RateLimiter,
    key: str,
    *,
    limit: int,
    window_seconds: int,
) -> None:
    try:
        limiter.check(key, limit=limit, window_seconds=window_seconds)
    except RateLimitExceeded as exc:
        raise HTTPException(
            status_code=429,
            detail="请求过于频繁，请稍后重试",
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc


def create_web_router(
    db: Database,
    settings: Settings,
    hub: AgentHub,
    limiter: RateLimiter,
) -> APIRouter:
    router = APIRouter(prefix="/api")
    python_builder = PythonAgentBuilder(settings.bundles_dir)

    def cleanup_expired_bundles() -> None:
        for filename in db.cleanup_expired_agent_bundles():
            (settings.bundles_dir / filename).unlink(missing_ok=True)

    def issue_agent_enrollment(
        user_id: str, label: str
    ) -> tuple[IssuedToken, dict[str, Any], int]:
        token = issue_token("enroll")
        expires_at = int(time.time()) + settings.enrollment_minutes * 60
        record = db.create_enrollment_token(
            user_id,
            label,
            token.prefix,
            token.digest,
            expires_at,
        )
        return token, record, expires_at

    def current_user(
        session_token: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    ) -> dict[str, Any]:
        if not session_token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="请先登录")
        user = db.get_session_user(hash_token(session_token))
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录已过期")
        if settings.local_workdir is not None and not user.get("is_owner"):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权访问本机执行模式")
        return user

    User = Annotated[dict[str, Any], Depends(current_user)]

    def start_session(response: Response, user_id: str) -> None:
        token = issue_token("session")
        session_days = min(settings.session_days, 1) if settings.local_workdir is not None else settings.session_days
        max_age = session_days * 24 * 60 * 60
        db.create_session(token.digest, user_id, int(time.time()) + max_age)
        response.set_cookie(
            SESSION_COOKIE,
            token.value,
            max_age=max_age,
            httponly=True,
            secure=settings.secure_cookies,
            samesite="lax",
            path="/",
        )

    @router.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/session")
    def session_status(
        session_token: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    ) -> dict[str, Any]:
        user = db.get_session_user(hash_token(session_token)) if session_token else None
        owner = db.get_owner() if settings.local_workdir is not None else None
        mfa_required = bool(owner and db.has_owner_mfa(owner["id"]))
        if settings.local_workdir is not None and user is not None and not user.get("is_owner"):
            user = None
        if user is None:
            return {
                "authenticated": False,
                "mode": "local" if settings.local_workdir is not None else "remote",
                "registration_enabled": settings.local_workdir is None,
                "mfa_required": mfa_required,
            }
        return {
            "authenticated": True,
            "user": user,
            "mcp_url": f"{settings.public_url}/mcp/",
            "agent_websocket_url": settings.websocket_url,
            "mode": "local" if settings.local_workdir is not None else "remote",
            "registration_enabled": settings.local_workdir is None,
            "mfa_required": mfa_required,
        }

    if settings.local_workdir is None:
        @router.post("/auth/register", status_code=201)
        def register(credentials: Credentials, response: Response, request: Request) -> dict[str, Any]:
            _enforce_rate_limit(
                limiter,
                f"register:ip:{client_key(request)}",
                limit=10,
                window_seconds=3600,
            )
            email = _normalize_email(credentials.email)
            try:
                user = db.create_user(email, hash_password(credentials.password))
            except ConflictError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            start_session(response, user["id"])
            return {"user": user}

    @router.post("/auth/login")
    def login(credentials: Credentials, response: Response, request: Request) -> dict[str, Any]:
        email = _normalize_email(credentials.email)
        peer = client_key(request)
        _enforce_rate_limit(
            limiter,
            f"login:ip:{peer}",
            limit=20,
            window_seconds=300,
        )
        _enforce_rate_limit(
            limiter,
            f"login:account:{email}",
            limit=8,
            window_seconds=300,
        )
        user = db.get_user_by_email(email)
        if (
            user is None
            or not verify_password(credentials.password, user["password_hash"])
            or (settings.local_workdir is not None and not user.get("is_owner"))
        ):
            raise HTTPException(status_code=401, detail="邮箱或密码错误")
        if (
            settings.local_workdir is not None
            and db.has_owner_mfa(user["id"])
            and not verify_owner_mfa_code(db, user["id"], credentials.mfa_code or "")
        ):
            raise HTTPException(status_code=401, detail="邮箱、密码或验证码错误")
        start_session(response, user["id"])
        return {
            "user": {key: user[key] for key in ("id", "email", "is_owner", "created_at")}
        }

    @router.post("/auth/logout", status_code=204)
    def logout(
        response: Response,
        session_token: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    ) -> None:
        if session_token:
            db.delete_session(hash_token(session_token))
        response.delete_cookie(SESSION_COOKIE, path="/")

    @router.get("/me")
    def me(user: User) -> dict[str, Any]:
        return {
            "user": user,
            "mcp_url": f"{settings.public_url}/mcp/",
            "agent_websocket_url": settings.websocket_url,
            "mode": "local" if settings.local_workdir is not None else "remote",
        }

    if settings.local_workdir is not None:
        @router.get("/audit-logs")
        def list_audit_logs(user: User, limit: int = 200) -> dict[str, Any]:
            return {"logs": db.list_audit_logs(user["id"], limit=limit)}

        return router

    @router.get("/mcp-keys")
    def list_mcp_keys(user: User) -> dict[str, Any]:
        return {"keys": db.list_mcp_keys(user["id"])}

    @router.post("/mcp-keys", status_code=201)
    def create_mcp_key(item: NamedItem, user: User) -> dict[str, Any]:
        token = issue_token("mcp")
        key = db.create_mcp_key(user["id"], item.name.strip(), token.prefix, token.digest)
        return {"key": key, "secret": token.value}

    @router.delete("/mcp-keys/{key_id}", status_code=204)
    def revoke_mcp_key(key_id: str, user: User) -> None:
        if not db.revoke_mcp_key(user["id"], key_id):
            raise HTTPException(status_code=404, detail="MCP Key 不存在")

    @router.get("/enrollment-tokens")
    def list_enrollment_tokens(user: User) -> dict[str, Any]:
        return {"tokens": db.list_enrollment_tokens(user["id"])}

    @router.post("/enrollment-tokens", status_code=201)
    def create_enrollment_token(item: NamedItem, user: User) -> dict[str, Any]:
        token, record, _ = issue_agent_enrollment(user["id"], item.name.strip())
        command = (
            f'python agent.py --gateway "{settings.websocket_url}" '
            f'--token "{token.value}"'
        )
        return {"token": record, "secret": token.value, "command": command}

    @router.delete("/enrollment-tokens/{token_id}", status_code=204)
    def revoke_enrollment_token(token_id: str, user: User) -> None:
        if not db.revoke_enrollment_token(user["id"], token_id):
            raise HTTPException(status_code=404, detail="注册令牌不存在或已被使用")

    @router.get("/agents")
    def list_agents(user: User) -> dict[str, Any]:
        return {"agents": [_agent_view(agent, hub) for agent in db.list_agents(user["id"])]}

    @router.get("/profile-catalog")
    def profile_catalog(user: User) -> dict[str, Any]:
        del user
        return {"profiles": public_profile_catalog(), "runtimes": ["python"]}

    @router.get("/agent-bundles")
    def list_agent_bundles(user: User) -> dict[str, Any]:
        cleanup_expired_bundles()
        bundles = db.list_agent_bundles(user["id"])
        for bundle in bundles:
            bundle["download_url"] = f"/api/agent-bundles/{bundle['id']}/download"
        return {"bundles": bundles}

    @router.post("/agent-bundles", status_code=201)
    def create_agent_bundle(request: AgentBundleRequest, user: User) -> dict[str, Any]:
        if request.runtime != "python":
            raise HTTPException(status_code=422, detail="当前只支持组装 Python Agent")
        name = request.name.strip()
        description = request.description.strip()
        try:
            selected_profiles = validate_profiles(request.profiles)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        cleanup_expired_bundles()
        bundle_id = new_bundle_id()
        try:
            path, filename = python_builder.build(
                bundle_id=bundle_id,
                name=name,
                description=description,
                profiles=selected_profiles,
            )
        except (ValueError, AgentBuildError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        token_record: dict[str, Any] | None = None
        try:
            enrollment, token_record, expires_at = issue_agent_enrollment(
                user["id"], f"Agent Bundle: {name}"
            )
            bundle = db.create_agent_bundle(
                bundle_id,
                user["id"],
                token_record["id"],
                name,
                description,
                request.runtime,
                selected_profiles,
                filename,
                expires_at,
            )
        except Exception:
            path.unlink(missing_ok=True)
            if token_record is not None:
                db.revoke_enrollment_token(user["id"], token_record["id"])
            raise
        bundle["download_url"] = f"/api/agent-bundles/{bundle_id}/download"
        command = (
            f'python run.py --gateway "{settings.websocket_url}" '
            f'--token "{enrollment.value}"'
        )
        install_command = " ".join(
            [
                "curl -fsSL",
                shlex.quote(f"{settings.public_url.rstrip('/')}/install-agent.sh"),
                "| sudo bash -s --",
                "--server", shlex.quote(settings.public_url.rstrip("/")),
                "--gateway", shlex.quote(settings.websocket_url),
                "--bundle-id", shlex.quote(bundle_id),
            ]
        )
        return {
            "bundle": bundle,
            "secret": enrollment.value,
            "command": command,
            "install_command": install_command,
        }

    @router.get("/agent-bundles/{bundle_id}/download")
    def download_agent_bundle(bundle_id: str, user: User) -> FileResponse:
        bundle = db.get_owned_agent_bundle(user["id"], bundle_id)
        if bundle is None:
            raise HTTPException(status_code=404, detail="Agent 组装包不存在")
        if bundle["expires_at"] <= int(time.time()):
            raise HTTPException(status_code=410, detail="Agent 组装包已过期，请重新生成")
        path = (settings.bundles_dir / bundle["filename"]).resolve()
        bundles_root = settings.bundles_dir.resolve()
        if path.parent != bundles_root or not path.is_file():
            raise HTTPException(status_code=404, detail="Agent 组装包文件不存在")
        return FileResponse(path, media_type="application/zip", filename=bundle["filename"])

    @router.get("/agent-bundles/{bundle_id}/install-download")
    def download_agent_bundle_for_install(
        bundle_id: str,
        request: Request,
        authorization: Annotated[str | None, Header()] = None,
    ) -> FileResponse:
        _enforce_rate_limit(
            limiter,
            f"agent-install:ip:{client_key(request)}",
            limit=60,
            window_seconds=300,
        )
        scheme, _, secret = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not secret.strip():
            raise HTTPException(status_code=404, detail="Agent 安装包不存在或已失效")
        cleanup_expired_bundles()
        bundle = db.get_installable_agent_bundle(bundle_id, hash_token(secret.strip()))
        if bundle is None:
            raise HTTPException(status_code=404, detail="Agent 安装包不存在或已失效")
        path = (settings.bundles_dir / bundle["filename"]).resolve()
        bundles_root = settings.bundles_dir.resolve()
        if path.parent != bundles_root or not path.is_file():
            raise HTTPException(status_code=404, detail="Agent 安装包文件不存在")
        return FileResponse(
            path,
            media_type="application/zip",
            filename=bundle["filename"],
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/agents/{agent_id}")
    def get_agent(agent_id: str, user: User) -> dict[str, Any]:
        agent = db.get_owned_agent(user["id"], agent_id)
        if agent is None:
            raise HTTPException(status_code=404, detail="Agent 不存在")
        result = _agent_view(agent, hub)
        result["profile_details"] = describe_profile_declarations(
            agent["profile_declarations"]
        )
        return {"agent": result}

    def authenticate_device(agent_id: str, authorization: str | None) -> dict[str, Any]:
        scheme, _, secret = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not secret.strip():
            raise HTTPException(status_code=404, detail="Agent 不存在或设备凭据无效")
        agent = db.authenticate_agent(agent_id, hash_token(secret.strip()))
        if agent is None:
            raise HTTPException(status_code=404, detail="Agent 不存在或设备凭据无效")
        return agent

    @router.get("/agents/{agent_id}/runtime-download")
    def download_agent_runtime(
        agent_id: str,
        request: Request,
        authorization: Annotated[str | None, Header()] = None,
    ) -> FileResponse:
        _enforce_rate_limit(
            limiter,
            f"agent-upgrade:ip:{client_key(request)}",
            limit=30,
            window_seconds=300,
        )
        agent = authenticate_device(agent_id, authorization)
        if not agent["profile_declarations"]:
            raise HTTPException(status_code=409, detail="该 Agent 需要重新注册，不能原地升级")
        try:
            selected_profiles = validate_profiles(agent["profiles"])
            path, filename = python_builder.build(
                bundle_id=new_bundle_id(),
                name=agent["name"],
                description=agent["description"],
                profiles=selected_profiles,
            )
        except (ValueError, AgentBuildError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return FileResponse(
            path,
            media_type="application/zip",
            filename=filename,
            headers={"Cache-Control": "no-store"},
            background=BackgroundTask(path.unlink, missing_ok=True),
        )

    @router.get("/agents/{agent_id}/self-status")
    def agent_self_status(
        agent_id: str,
        authorization: Annotated[str | None, Header()] = None,
    ) -> dict[str, Any]:
        agent = authenticate_device(agent_id, authorization)
        view = _agent_view(agent, hub)
        return {
            "agent_id": agent_id,
            "online": view["online"],
            "version": view["version"],
            "version_status": view["version_status"],
            "lifecycle_status": view["lifecycle_status"],
        }

    @router.patch("/agents/{agent_id}")
    def update_agent(agent_id: str, update: AgentUpdate, user: User) -> dict[str, Any]:
        if not db.update_agent(user["id"], agent_id, update.name.strip(), update.description.strip()):
            raise HTTPException(status_code=404, detail="Agent 不存在")
        agent = db.get_owned_agent(user["id"], agent_id)
        return {"agent": _agent_view(agent, hub)}

    @router.patch("/agents/{agent_id}/shell-policy")
    def update_agent_shell_policy(
        agent_id: str, update: ShellPolicyUpdate, user: User
    ) -> dict[str, Any]:
        agent = db.get_owned_agent(user["id"], agent_id)
        if agent is None:
            raise HTTPException(status_code=404, detail="Agent 不存在")
        if "shell.v1" not in agent["profiles"]:
            raise HTTPException(status_code=422, detail="该 Agent 未声明 shell.v1")
        db.update_agent_shell_policy(user["id"], agent_id, update.mode)
        updated = db.get_owned_agent(user["id"], agent_id)
        return {"agent": _agent_view(updated, hub)}

    @router.delete("/agents/{agent_id}", status_code=204)
    async def revoke_agent(agent_id: str, user: User) -> None:
        if not db.revoke_agent(user["id"], agent_id):
            raise HTTPException(status_code=404, detail="Agent 不存在")
        await hub.disconnect(agent_id)

    return router
