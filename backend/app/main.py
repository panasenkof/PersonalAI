from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.auth import router as auth_router
from app.api.v1.collections import router as collections_router
from app.api.v1.conversations import router as conversations_router
from app.api.v1.messages import router as messages_router
from app.api.v1.settings_llm import router as settings_router
from app.channels.telegram import router as telegram_router
from app.config import get_settings
from app.db import init_db


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    yield


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


@app.middleware("http")
async def request_context(request: Request, call_next):
    # Correlation id in, echoed back out — grep-able across logs.
    corr = request.headers.get("X-Correlation-Id") or request.headers.get("X-Request-Id")
    response = await call_next(request)
    if corr:
        response.headers["X-Correlation-Id"] = corr
    return response


app.include_router(auth_router)
app.include_router(settings_router)
app.include_router(messages_router)
app.include_router(collections_router)
app.include_router(conversations_router)
app.include_router(telegram_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
