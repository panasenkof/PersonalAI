import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1.account import router as account_router
from app.api.v1.admin import router as admin_router
from app.api.v1.auth import router as auth_router
from app.api.v1.collections import router as collections_router
from app.api.v1.conversations import router as conversations_router
from app.api.v1.email_actions import router as email_router
from app.api.v1.facts import router as facts_router
from app.api.v1.messages import router as messages_router
from app.api.v1.service import router as service_router
from app.api.v1.settings_llm import router as settings_router
from app.api.v1.stats import router as stats_router
from app.channels.discord import router as discord_router
from app.channels.slack import router as slack_router
from app.channels.telegram import router as telegram_router
from app.channels.whatsapp import router as whatsapp_router
from app.config import get_settings, production_problems
from app.db import init_db
from app.mcp.server import router as mcp_router
from app.observability import RequestTimer, configure_logging, log_event
from app.security.ratelimit import SlidingWindowLimiter

_logger = logging.getLogger("pia.http")


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    problems = production_problems(settings)
    if settings.is_production and problems:
        raise RuntimeError("Refusing to start in production: " + "; ".join(problems))
    for p in problems:
        _logger.warning("config: %s", p)
    await init_db()

    from app.queue.runner import get_runner

    runner = get_runner()
    if settings.message_mode == "queue" or settings.queue_backend == "redis":
        await runner.start()
    stop = asyncio.Event()
    from app.services.mail import maintenance_loop

    maintenance = asyncio.create_task(maintenance_loop(stop))
    from app.queue.delivery import delivery_loop

    delivery = asyncio.create_task(delivery_loop(stop))
    task: asyncio.Task | None = None
    if settings.reminders_enabled:
        from app.scheduler.reminders import reminders_loop

        task = asyncio.create_task(reminders_loop(stop))
    try:
        yield
    finally:
        stop.set()
        delivery.cancel()
        await asyncio.gather(delivery, return_exceptions=True)
        try:
            await asyncio.wait_for(maintenance, timeout=5)
        except (TimeoutError, asyncio.CancelledError):
            maintenance.cancel()
            await asyncio.gather(maintenance, return_exceptions=True)
        if task is not None:
            try:
                await asyncio.wait_for(task, timeout=5)
            except (TimeoutError, asyncio.CancelledError):
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        if settings.message_mode == "queue" or settings.queue_backend == "redis":
            await runner.stop()
        if settings.redis_url:
            from app.queue.redis_client import close_redis

            await close_redis()


configure_logging()

app = FastAPI(title="PIA Agent", lifespan=lifespan)

_settings = get_settings()
_origins = _settings.cors_origin_list
# Browsers reject Access-Control-Allow-Origin: * together with credentials.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


_access_limiter = SlidingWindowLimiter(limit=_settings.rate_limit_auth_per_minute)
_AUTH_PATHS = ("/v1/auth/register", "/v1/auth/token", "/v1/auth/password/request", "/v1/auth/email/request", "/v1/auth/password/reset", "/v1/auth/email/verify")
_shared_ip_limiter: tuple[tuple[str, int], object] | None = None


def _client_ip(request: Request) -> str:
    settings = get_settings()
    if settings.trust_proxy_headers:
        # Select from the right across the configured, known proxy chain.
        forwarded = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
        hops = max(1, settings.trusted_proxy_hops)
        if len(forwarded) >= hops:
            from ipaddress import ip_address

            try:
                return str(ip_address(forwarded[-hops]))
            except ValueError:
                pass
    return request.client.host if request.client else "unknown"


async def _auth_ip_allowed(client: str) -> bool:
    """Per-IP limit for register/login: shared by all replicas through Redis when configured."""
    global _shared_ip_limiter
    s = get_settings()
    if s.redis_url:
        limit = _settings.rate_limit_auth_per_minute  # same value that switched the check on
        key = (s.redis_url, limit)
        if _shared_ip_limiter is None or _shared_ip_limiter[0] != key:
            from app.security.ratelimit import build_limiter

            _shared_ip_limiter = (key, build_limiter("auth-ip", limit))
        return await _shared_ip_limiter[1].allow(client)  # type: ignore[attr-defined]
    return _access_limiter.allow(client)


@app.middleware("http")
async def request_context(request: Request, call_next):
    # Correlation id in, echoed back out — grep-able across logs.
    corr = request.headers.get("X-Correlation-Id") or request.headers.get("X-Request-Id")
    if request.url.path in _AUTH_PATHS and _settings.rate_limit_auth_per_minute > 0:
        if not await _auth_ip_allowed(_client_ip(request)):
            return JSONResponse(status_code=429, content={"detail": "rate_limited"})
    timer = RequestTimer()
    response = await call_next(request)
    if corr:
        response.headers["X-Correlation-Id"] = corr
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if not request.url.path.startswith("/app"):
        response.headers.setdefault("X-Frame-Options", "DENY")
    if get_settings().is_production:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    log_event(
        _logger,
        "request",
        method=request.method,
        path=request.url.path,
        status=response.status_code,
        ms=timer.ms(),
        correlation_id=corr or "-",
    )
    return response


app.include_router(auth_router)
app.include_router(email_router)
app.include_router(account_router)
app.include_router(service_router)
app.include_router(settings_router)
app.include_router(messages_router)
app.include_router(collections_router)
app.include_router(conversations_router)
app.include_router(stats_router)
app.include_router(facts_router)
app.include_router(admin_router)
app.include_router(whatsapp_router)
app.include_router(discord_router)
app.include_router(telegram_router)
app.include_router(slack_router)
app.include_router(mcp_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
async def ready() -> JSONResponse:
    """Readiness: database (and Redis when configured) must answer."""
    from sqlalchemy import text

    from app.db import engine

    checks: dict[str, str] = {}
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001
        _logger.warning("readiness: database check failed: %s", exc)
        checks["database"] = "error"
    if _settings.redis_url:
        try:
            from app.queue.redis_client import get_redis

            await get_redis().ping()
            checks["redis"] = "ok"
        except Exception as exc:  # noqa: BLE001
            _logger.warning("readiness: redis check failed: %s", exc)
            checks["redis"] = "error"
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse({"status": "ok" if ok else "degraded", **checks}, status_code=200 if ok else 503)


@app.get("/")
async def root() -> RedirectResponse:
    return RedirectResponse("/app/")


# Web chat UI (static SPA — talks to the same API via relative URLs)
app.mount("/app", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "web"), html=True), name="web")
