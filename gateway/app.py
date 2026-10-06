from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .agent_api import handle_agent_websocket
from .agent_hub import AgentHub
from .config import Settings
from .database import Database
from .local_runtime import LocalCommandRuntime
from .mcp_api import create_mcp_server
from .oauth import create_oauth_router
from .rate_limit import RateLimiter
from .web_api import create_web_router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    db = Database(settings.database_path)
    hub = AgentHub()
    rate_limiter = RateLimiter()
    local_runtime = (
        LocalCommandRuntime(
            settings.local_workdir,
            settings.max_command_timeout,
            exec_user=settings.local_exec_user,
            allowed_workdirs=settings.local_workdirs,
        )
        if settings.local_workdir is not None
        else None
    )
    mcp_server = create_mcp_server(db, hub, settings, local_runtime=local_runtime)
    mcp_app = mcp_server.streamable_http_app()
    static_dir = Path(__file__).parent / "static"
    installers_dir = Path(__file__).parent / "installers"

    async def heartbeat_loop() -> None:
        while True:
            await asyncio.sleep(20)
            await hub.heartbeat(timeout=60)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        db.initialize()
        owner = db.get_owner() if local_runtime is not None else None
        if local_runtime is not None and owner is None:
            raise RuntimeError(
                "本机执行模式尚未初始化 Owner。请先运行: "
                "python -m gateway.bootstrap_owner owner@example.com"
            )
        if (
            local_runtime is not None
            and settings.local_exec_user is not None
            and owner is not None
            and not db.has_owner_mfa(owner["id"])
        ):
            raise RuntimeError(
                "公网本机执行模式尚未配置 Owner MFA。请运行: "
                "python -m gateway.configure_mfa owner@example.com"
            )
        if local_runtime is not None:
            await local_runtime.verify_execution_identity()
        async with mcp_app.router.lifespan_context(mcp_app):
            heartbeat_task = asyncio.create_task(heartbeat_loop())
            try:
                yield
            finally:
                heartbeat_task.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat_task
                await hub.close_all()
                if local_runtime is not None:
                    await local_runtime.close()

    app = FastAPI(
        title="Remote Runtime",
        version=__version__,
        docs_url=None if local_runtime is not None else "/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.database = db
    app.state.agent_hub = hub
    app.state.rate_limiter = rate_limiter
    app.state.local_runtime = local_runtime
    app.state.mcp_server = mcp_server
    app.include_router(create_web_router(db, settings, hub, rate_limiter))
    app.include_router(create_oauth_router(db, settings, rate_limiter))

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        form_action = (
            "'self' https://chatgpt.com"
            if request.url.path == "/oauth/authorize"
            else "'self'"
        )
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; "
            "style-src 'self'; script-src 'self'; frame-ancestors 'none'; "
            f"base-uri 'none'; form-action {form_action}"
        )
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        if urlparse(settings.public_url).scheme == "https":
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    if local_runtime is None:
        @app.websocket("/ws/agent")
        async def agent_socket(websocket: WebSocket) -> None:
            await handle_agent_websocket(websocket, db, hub)

        @app.get("/install-agent.sh", include_in_schema=False)
        async def install_agent_script() -> FileResponse:
            return FileResponse(
                installers_dir / "install-agent.sh",
                media_type="text/x-shellscript",
                headers={"Cache-Control": "no-store"},
            )

        @app.get("/upgrade-agent.sh", include_in_schema=False)
        async def upgrade_agent_script() -> FileResponse:
            return FileResponse(
                installers_dir / "upgrade-agent.sh",
                media_type="text/x-shellscript",
                headers={"Cache-Control": "no-store"},
            )

    if static_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=static_dir), name="assets")

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(static_dir / "index.html")

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon() -> Response:
        return Response(status_code=204)

    app.mount("/mcp", mcp_app, name="mcp")
    return app


app = create_app()
