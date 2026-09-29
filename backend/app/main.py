import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1.auth import router as auth_router
from app.api.v1.collections import router as collections_router
from app.api.v1.conversations import router as conversations_router
from app.api.v1.messages import router as messages_router
from app.api.v1.settings_llm import router as settings_router
from app.api.v1.stats import router as stats_router
from app.channels.slack import router as slack_router
from app.channels.telegram import router as telegram_router
from app.config import get_settings
from app.db import init_db
from app.mcp.server import router as mcp_router
from app.observability import RequestTimer, configure_logging, log_event
from app.security.ratelimit import SlidingWindowLimiter


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    stop = asyncio.Event()
    task: asyncio.Task | None = None
    if get_settings().reminders_enabled:
        from app.scheduler.reminders import reminders_loop

        task = asyncio.create_task(reminders_loop(stop))
    try:
        yield
    finally:
        stop.set()
        if task is not None:
            try:
                await asyncio.wait_for(task, timeout=5)
            except (TimeoutError, asyncio.CancelledError):
                task.cancel()


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
_AUTH_PATHS = ("/v1/auth/register", "/v1/auth/token")
_logger = logging.getLogger("pia.http")


@app.middleware("http")
async def request_context(request: Request, call_next):
    # Correlation id in, echoed back out — grep-able across logs.
    corr = request.headers.get("X-Correlation-Id") or request.headers.get("X-Request-Id")
    if request.url.path in _AUTH_PATHS and _settings.rate_limit_auth_per_minute > 0:
        client = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        client = client or (request.client.host if request.client else "unknown")
        if not _access_limiter.allow(client):
            return JSONResponse(status_code=429, content={"detail": "rate_limited"})
    timer = RequestTimer()
    response = await call_next(request)
    if corr:
        response.headers["X-Correlation-Id"] = corr
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
app.include_router(settings_router)
app.include_router(messages_router)
app.include_router(collections_router)
app.include_router(conversations_router)
app.include_router(stats_router)
app.include_router(telegram_router)
app.include_router(slack_router)
app.include_router(mcp_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
async def root() -> RedirectResponse:
    return RedirectResponse("/app/")


# Web chat UI (static SPA — talks to the same API via relative URLs)
app.mount("/app", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "web"), html=True), name="web")
