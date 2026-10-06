from __future__ import annotations

import base64
import hashlib
import html
import hmac
import re
import time
import uuid
from typing import Any
from urllib.parse import urlencode, urlparse

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, Field

from .config import Settings
from .database import Database, OAuthRefreshReplayError
from .mfa import verify_owner_mfa_code
from .rate_limit import RateLimitExceeded, RateLimiter, client_key
from .security import hash_token, issue_token, verify_password


OAUTH_SCOPES = ("gateway:use", "offline_access")
ACCESS_TOKEN_TTL_SECONDS = 3600
REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
AUTHORIZATION_CODE_TTL_SECONDS = 300
OAUTH_CSRF_COOKIE = "remote_gateway_oauth_csrf"
CHATGPT_STABLE_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect"
PKCE_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
PKCE_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")


class OAuthClientRegistration(BaseModel):
    redirect_uris: list[str] = Field(min_length=1, max_length=16)
    token_endpoint_auth_method: str | None = None
    grant_types: list[str] = Field(default_factory=lambda: ["authorization_code", "refresh_token"])
    response_types: list[str] = Field(default_factory=lambda: ["code"])
    scope: str | None = None
    client_name: str | None = Field(default=None, max_length=200)


def oauth_resource(settings: Settings) -> str:
    return f"{settings.public_url}/mcp/"


def _scope_list(raw: str | None, *, default: tuple[str, ...] = OAUTH_SCOPES) -> list[str]:
    scopes = list(default) if raw is None or not raw.strip() else raw.split()
    if not scopes or "gateway:use" not in scopes:
        raise ValueError("scope 必须包含 gateway:use")
    unsupported = sorted(set(scopes) - set(OAUTH_SCOPES))
    if unsupported:
        raise ValueError(f"不支持的 scope: {', '.join(unsupported)}")
    return list(dict.fromkeys(scopes))


def _validate_redirect_uri(raw: str) -> str:
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc or parsed.fragment:
        raise ValueError("redirect_uri 无效")
    if parsed.scheme == "https":
        return raw
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return raw
    raise ValueError("redirect_uri 必须使用 HTTPS；仅 localhost 允许 HTTP")


def _validate_resource(raw: str | None, settings: Settings) -> str:
    expected = oauth_resource(settings)
    if raw is None or raw.rstrip("/") != expected.rstrip("/"):
        raise ValueError(f"resource 必须为 {expected}")
    return expected


def _redirect_uri_with_params(base: str, **params: str | None) -> str:
    clean = {key: value for key, value in params.items() if value is not None}
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{urlencode(clean)}"


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _oauth_error(error: str, description: str, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": error, "error_description": description},
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


def _authorization_request(
    values: dict[str, str], db: Database, settings: Settings
) -> dict[str, Any]:
    client_id = values.get("client_id", "")
    client = db.get_oauth_client(client_id)
    if client is None:
        raise ValueError("未知 OAuth client_id")
    if values.get("response_type") != "code":
        raise ValueError("response_type 必须为 code")
    if values.get("code_challenge_method") != "S256":
        raise ValueError("code_challenge_method 必须为 S256")
    code_challenge = values.get("code_challenge", "")
    if not PKCE_CHALLENGE_RE.fullmatch(code_challenge):
        raise ValueError("code_challenge 无效")

    redirect_uri = _validate_redirect_uri(values.get("redirect_uri", ""))
    if redirect_uri not in client["redirect_uris"]:
        raise ValueError("redirect_uri 未注册")
    scopes = _scope_list(values.get("scope"), default=tuple(client["scope"].split()))
    if not set(scopes).issubset(set(client["scope"].split())):
        raise ValueError("请求 scope 超出 client 注册范围")
    resource = _validate_resource(values.get("resource"), settings)
    return {
        "client": client,
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scopes": scopes,
        "resource": resource,
        "code_challenge": code_challenge,
        "state": values.get("state"),
    }


def _consent_page(
    request_values: dict[str, str],
    *,
    user_email: str | None,
    client_name: str,
    redirect_uri: str,
    csrf_token: str,
    require_mfa: bool,
    error: str | None = None,
) -> str:
    hidden = "\n".join(
        f'<input type="hidden" name="{html.escape(key)}" value="{html.escape(value, quote=True)}">'
        for key, value in request_values.items()
    )
    if user_email:
        identity = (
            f"<p>将以 <strong>{html.escape(user_email)}</strong> 授权当前 MCP 客户端访问此服务。</p>"
            '<input type="hidden" name="use_session" value="1">'
        )
    else:
        mfa_field = (
            '<br><label>验证码 <input name="mfa_code" type="text" '
            'autocomplete="one-time-code" maxlength="64" required></label>'
            if require_mfa
            else ""
        )
        identity = f"""
<label>邮箱 <input name="email" type="email" autocomplete="username" required></label><br>
<label>密码 <input name="password" type="password" autocomplete="current-password" required></label>
{mfa_field}
"""
    error_html = f"<p>{html.escape(error)}</p>" if error else ""
    return f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>授权 ChatGPT</title></head>
<body>
<main>
<h1>授权 MCP 客户端</h1>
<p>客户端：<strong>{html.escape(client_name)}</strong></p>
<p>回调地址：<code>{html.escape(redirect_uri)}</code></p>
<p>授权后，该客户端可按当前 Gateway 系统账号权限执行服务器命令。请只授权你刚刚主动添加的客户端。</p>
{error_html}
<form method="post" action="/oauth/authorize">
{hidden}
<input type="hidden" name="csrf_token" value="{html.escape(csrf_token, quote=True)}">
{identity}
<p>
<button type="submit" name="decision" value="allow">授权</button>
<button type="submit" name="decision" value="deny">取消</button>
</p>
</form>
</main>
</body>
</html>"""


def _check_rate(
    limiter: RateLimiter,
    key: str,
    *,
    limit: int,
    window_seconds: int,
) -> Response | None:
    try:
        limiter.check(key, limit=limit, window_seconds=window_seconds)
    except RateLimitExceeded as exc:
        response = _oauth_error("slow_down", "请求过于频繁，请稍后重试", 429)
        response.headers["Retry-After"] = str(exc.retry_after)
        return response
    return None


def create_oauth_router(db: Database, settings: Settings, limiter: RateLimiter) -> APIRouter:
    router = APIRouter()
    resource = oauth_resource(settings)

    @router.get("/.well-known/oauth-protected-resource")
    @router.get("/.well-known/oauth-protected-resource/mcp/")
    def protected_resource_metadata() -> dict[str, Any]:
        return {
            "resource": resource,
            "authorization_servers": [settings.public_url],
            "scopes_supported": ["gateway:use"],
            "bearer_methods_supported": ["header"],
            "resource_name": "Remote Runtime",
        }

    @router.get("/.well-known/oauth-authorization-server")
    def authorization_server_metadata() -> dict[str, Any]:
        return {
            "issuer": settings.public_url,
            "authorization_endpoint": f"{settings.public_url}/oauth/authorize",
            "token_endpoint": f"{settings.public_url}/oauth/token",
            "registration_endpoint": f"{settings.public_url}/oauth/register",
            "revocation_endpoint": f"{settings.public_url}/oauth/revoke",
            "scopes_supported": list(OAUTH_SCOPES),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": ["none"],
            "code_challenge_methods_supported": ["S256"],
            "authorization_response_iss_parameter_supported": True,
        }

    @router.post("/oauth/register", status_code=201)
    def register_client(payload: OAuthClientRegistration, request: Request) -> Response:
        limited = _check_rate(
            limiter,
            f"oauth:register:{client_key(request)}",
            limit=20,
            window_seconds=3600,
        )
        if limited is not None:
            return limited
        if payload.token_endpoint_auth_method not in {None, "none"}:
            return _oauth_error(
                "invalid_client_metadata",
                "仅支持 token_endpoint_auth_method=none；授权码交换使用 PKCE S256",
            )
        if not {"authorization_code", "refresh_token"}.issubset(set(payload.grant_types)):
            return _oauth_error(
                "invalid_client_metadata",
                "grant_types 必须包含 authorization_code 和 refresh_token",
            )
        if "code" not in payload.response_types:
            return _oauth_error("invalid_client_metadata", "response_types 必须包含 code")
        try:
            redirect_uris = [_validate_redirect_uri(uri) for uri in payload.redirect_uris]
            scopes = _scope_list(payload.scope)
        except ValueError as exc:
            return _oauth_error("invalid_client_metadata", str(exc))
        if settings.local_workdir is not None and redirect_uris != [CHATGPT_STABLE_REDIRECT_URI]:
            return _oauth_error(
                "invalid_client_metadata",
                "本机执行模式只允许 ChatGPT 稳定 OAuth 回调地址",
            )

        client_id = str(uuid.uuid4())
        record = db.create_oauth_client(
            client_id,
            redirect_uris,
            " ".join(scopes),
            payload.client_name,
        )
        return JSONResponse(
            status_code=201,
            content={
                "client_id": record["id"],
                "client_id_issued_at": record["created_at"],
                "redirect_uris": redirect_uris,
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "scope": record["scope"],
                "client_name": record["client_name"],
            },
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/oauth/authorize", response_class=HTMLResponse)
    async def authorize_get(request: Request) -> Response:
        limited = _check_rate(
            limiter,
            f"oauth:authorize:get:{client_key(request)}",
            limit=120,
            window_seconds=60,
        )
        if limited is not None:
            return limited
        values = {key: value for key, value in request.query_params.items()}
        try:
            auth = _authorization_request(values, db, settings)
        except ValueError as exc:
            return HTMLResponse(str(exc), status_code=400, headers={"Cache-Control": "no-store"})
        session_token = request.cookies.get("remote_gateway_session")
        user = db.get_session_user(hash_token(session_token)) if session_token else None
        if settings.local_workdir is not None and user is not None and not user.get("is_owner"):
            user = None
        owner = db.get_owner() if settings.local_workdir is not None else None
        require_mfa = bool(owner and db.has_owner_mfa(owner["id"]))
        csrf_token = issue_token("csrf", entropy_bytes=24).value
        response = HTMLResponse(
            _consent_page(
                values,
                user_email=user["email"] if user else None,
                client_name=auth["client"].get("client_name") or auth["client_id"],
                redirect_uri=auth["redirect_uri"],
                csrf_token=csrf_token,
                require_mfa=require_mfa,
            ),
            headers={"Cache-Control": "no-store"},
        )
        response.set_cookie(
            OAUTH_CSRF_COOKIE,
            csrf_token,
            max_age=600,
            httponly=True,
            secure=settings.secure_cookies,
            samesite="strict",
            path="/oauth/authorize",
        )
        return response

    @router.post("/oauth/authorize", response_class=HTMLResponse)
    async def authorize_post(request: Request) -> Response:
        limited = _check_rate(
            limiter,
            f"oauth:authorize:post:{client_key(request)}",
            limit=30,
            window_seconds=300,
        )
        if limited is not None:
            return limited
        form = await request.form()
        form_csrf = str(form.get("csrf_token", ""))
        cookie_csrf = request.cookies.get(OAUTH_CSRF_COOKIE, "")
        if not form_csrf or not cookie_csrf or not hmac.compare_digest(form_csrf, cookie_csrf):
            return HTMLResponse(
                "OAuth 授权请求已过期或 CSRF 校验失败，请重新发起授权",
                status_code=400,
                headers={"Cache-Control": "no-store"},
            )
        values = {
            key: str(form.get(key, ""))
            for key in (
                "client_id",
                "redirect_uri",
                "response_type",
                "code_challenge",
                "code_challenge_method",
                "state",
                "scope",
                "resource",
            )
            if form.get(key) is not None
        }
        try:
            auth = _authorization_request(values, db, settings)
        except ValueError as exc:
            return HTMLResponse(str(exc), status_code=400, headers={"Cache-Control": "no-store"})

        if form.get("decision") == "deny":
            response = RedirectResponse(
                _redirect_uri_with_params(
                    auth["redirect_uri"],
                    error="access_denied",
                    state=auth["state"],
                    iss=settings.public_url,
                ),
                status_code=302,
                headers={"Cache-Control": "no-store"},
            )
            response.delete_cookie(OAUTH_CSRF_COOKIE, path="/oauth/authorize")
            return response

        session_token = request.cookies.get("remote_gateway_session")
        user = db.get_session_user(hash_token(session_token)) if session_token else None
        if settings.local_workdir is not None and user is not None and not user.get("is_owner"):
            user = None
        if user is None:
            email = str(form.get("email", "")).strip().lower()
            password = str(form.get("password", ""))
            mfa_code = str(form.get("mfa_code", ""))
            account_limited = _check_rate(
                limiter,
                f"oauth:password:{email or 'unknown'}",
                limit=8,
                window_seconds=300,
            )
            if account_limited is not None:
                return account_limited
            stored = db.get_user_by_email(email)
            if (
                stored is None
                or not verify_password(password, stored["password_hash"])
                or (settings.local_workdir is not None and not stored.get("is_owner"))
            ):
                return HTMLResponse(
                    _consent_page(
                        values,
                        user_email=None,
                        client_name=auth["client"].get("client_name") or auth["client_id"],
                        redirect_uri=auth["redirect_uri"],
                        csrf_token=form_csrf,
                        require_mfa=bool(
                            stored
                            and stored.get("is_owner")
                            and db.has_owner_mfa(stored["id"])
                        ),
                        error="邮箱或密码错误",
                    ),
                    status_code=401,
                    headers={"Cache-Control": "no-store"},
                )
            if (
                settings.local_workdir is not None
                and db.has_owner_mfa(stored["id"])
                and not verify_owner_mfa_code(db, stored["id"], mfa_code)
            ):
                return HTMLResponse(
                    _consent_page(
                        values,
                        user_email=None,
                        client_name=auth["client"].get("client_name") or auth["client_id"],
                        redirect_uri=auth["redirect_uri"],
                        csrf_token=form_csrf,
                        require_mfa=True,
                        error="邮箱、密码或验证码错误",
                    ),
                    status_code=401,
                    headers={"Cache-Control": "no-store"},
                )
            user = stored

        code = issue_token("oauthc")
        db.create_oauth_code(
            code_hash=code.digest,
            client_id=auth["client_id"],
            user_id=user["id"],
            redirect_uri=auth["redirect_uri"],
            code_challenge=auth["code_challenge"],
            scopes=auth["scopes"],
            resource=auth["resource"],
            expires_at=int(time.time()) + AUTHORIZATION_CODE_TTL_SECONDS,
        )
        response = RedirectResponse(
            _redirect_uri_with_params(
                auth["redirect_uri"],
                code=code.value,
                state=auth["state"],
                iss=settings.public_url,
            ),
            status_code=302,
            headers={"Cache-Control": "no-store"},
        )
        response.delete_cookie(OAUTH_CSRF_COOKIE, path="/oauth/authorize")
        return response

    @router.post("/oauth/token")
    async def token(request: Request) -> Response:
        limited = _check_rate(
            limiter,
            f"oauth:token:{client_key(request)}",
            limit=60,
            window_seconds=60,
        )
        if limited is not None:
            return limited
        form = await request.form()
        client_id = str(form.get("client_id", ""))
        if not client_id or db.get_oauth_client(client_id) is None:
            return _oauth_error("invalid_client", "client_id 无效", 401)
        grant_type = str(form.get("grant_type", ""))

        if grant_type == "authorization_code":
            code = str(form.get("code", ""))
            verifier = str(form.get("code_verifier", ""))
            redirect_uri = str(form.get("redirect_uri", ""))
            if not code or not verifier or not redirect_uri:
                return _oauth_error("invalid_request", "缺少 code、code_verifier 或 redirect_uri")
            if not PKCE_VERIFIER_RE.fullmatch(verifier):
                return _oauth_error("invalid_grant", "code_verifier 无效")
            try:
                request_resource = _validate_resource(
                    str(form.get("resource")) if form.get("resource") is not None else None,
                    settings,
                )
                challenge = _pkce_challenge(verifier)
            except (ValueError, UnicodeEncodeError) as exc:
                return _oauth_error("invalid_grant", str(exc))
            record = db.consume_oauth_code(
                code_hash=hash_token(code),
                client_id=client_id,
                redirect_uri=redirect_uri,
                code_challenge=challenge,
                resource=request_resource,
            )
            if record is None:
                return _oauth_error("invalid_grant", "授权码无效、已使用或 PKCE 校验失败")
            return _issue_oauth_tokens(db, record, include_refresh="offline_access" in record["scopes"])

        if grant_type == "refresh_token":
            refresh_token = str(form.get("refresh_token", ""))
            if not refresh_token:
                return _oauth_error("invalid_request", "缺少 refresh_token")
            try:
                request_resource = _validate_resource(
                    str(form.get("resource")) if form.get("resource") is not None else resource,
                    settings,
                )
            except ValueError as exc:
                return _oauth_error("invalid_grant", str(exc))
            requested_scope = str(form.get("scope", "")).strip()
            if requested_scope:
                try:
                    requested_scopes = _scope_list(requested_scope)
                except ValueError as exc:
                    return _oauth_error("invalid_scope", str(exc))
            else:
                requested_scopes = None
            try:
                record = db.consume_oauth_refresh_token(
                    hash_token(refresh_token), client_id, request_resource
                )
            except OAuthRefreshReplayError:
                return _oauth_error(
                    "invalid_grant",
                    "检测到 refresh token 重放，当前授权已全部撤销，请重新授权",
                )
            if record is None:
                return _oauth_error("invalid_grant", "refresh_token 无效或已失效")
            if requested_scopes is not None:
                if not set(requested_scopes).issubset(set(record["scopes"])):
                    return _oauth_error("invalid_scope", "请求 scope 超出原授权范围")
                record["scopes"] = requested_scopes
            return _issue_oauth_tokens(db, record, include_refresh=True)

        return _oauth_error("unsupported_grant_type", "仅支持 authorization_code 和 refresh_token")

    @router.post("/oauth/revoke", status_code=200)
    async def revoke(request: Request) -> Response:
        limited = _check_rate(
            limiter,
            f"oauth:revoke:{client_key(request)}",
            limit=60,
            window_seconds=60,
        )
        if limited is not None:
            return limited
        form = await request.form()
        token_value = str(form.get("token", ""))
        if token_value:
            db.revoke_oauth_token(hash_token(token_value))
        return Response(status_code=200, headers={"Cache-Control": "no-store"})

    return router


def _issue_oauth_tokens(
    db: Database,
    record: dict[str, Any],
    *,
    include_refresh: bool,
) -> JSONResponse:
    now = int(time.time())
    family_id = record.get("family_id") or str(uuid.uuid4())
    access = issue_token("oauth")
    db.create_oauth_access_token(
        token_hash=access.digest,
        client_id=record["client_id"],
        user_id=record["user_id"],
        family_id=family_id,
        scopes=record["scopes"],
        resource=record["resource"],
        expires_at=now + ACCESS_TOKEN_TTL_SECONDS,
    )
    refresh_value: str | None = None
    if include_refresh:
        refresh = issue_token("oauthr")
        refresh_value = refresh.value
        db.create_oauth_refresh_token(
            token_hash=refresh.digest,
            client_id=record["client_id"],
            user_id=record["user_id"],
            family_id=family_id,
            scopes=record["scopes"],
            resource=record["resource"],
            expires_at=now + REFRESH_TOKEN_TTL_SECONDS,
        )
    content: dict[str, Any] = {
        "access_token": access.value,
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_TTL_SECONDS,
        "scope": " ".join(record["scopes"]),
    }
    if refresh_value is not None:
        content["refresh_token"] = refresh_value
    return JSONResponse(
        content=content,
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )
