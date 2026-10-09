from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from app.agent.orchestrator import _run_tool
from app.agent.universal_tools import UNIVERSAL_TOOL_DEFINITIONS, UNIVERSAL_TOOL_HANDLERS
from app.db import SessionLocal
from app.domains.registry import all_plugins, tool_router, tools_openai_format
from app.llm.limits import RateLimitExceeded, check_user_quota
from app.security.redact import safe_error
from app.models import LLMSettings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mcp", tags=["mcp"])

PROTOCOL_VERSION = "2025-06-18"


def _mcp_tools() -> list[dict[str, Any]]:
    """Expose the agent's tool set in MCP format (OpenAI defs → inputSchema)."""
    out: list[dict[str, Any]] = []
    for tool in UNIVERSAL_TOOL_DEFINITIONS + tools_openai_format(all_plugins()):
        fn = tool.get("function") or {}
        out.append(
            {
                "name": fn.get("name"),
                "description": fn.get("description", ""),
                "inputSchema": fn.get("parameters") or {"type": "object", "properties": {}},
            }
        )
    return out


def _rpc_result(req_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _rpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


@router.post("")
async def mcp_endpoint(request: Request) -> Response:
    """MCP Streamable HTTP endpoint (single-message subset).

    Methods: initialize, ping, tools/list, tools/call.
    Auth: the same JWT bearer as the REST API — tools run as that user.
    """
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return JSONResponse(_rpc_error(None, -32700, "Parse error"), status_code=400)

    # Notifications (no id) require 202 Accepted with no body.
    if isinstance(payload, dict) and payload.get("id") is None and "method" in payload:
        return Response(status_code=202)

    if not isinstance(payload, dict) or "method" not in payload:
        return JSONResponse(_rpc_error(None, -32600, "Invalid Request"), status_code=400)

    req_id = payload.get("id")
    method = payload.get("method")
    params = payload.get("params") or {}

    if not isinstance(params, dict):
        return JSONResponse(_rpc_error(req_id, -32602, "Invalid params"), status_code=400)

    if method == "initialize":
        return JSONResponse(
            _rpc_result(
                req_id,
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "pia-agent", "version": "0.2.0"},
                },
            )
        )
    if method == "ping":
        return JSONResponse(_rpc_result(req_id, {}))
    if method == "tools/list":
        return JSONResponse(_rpc_result(req_id, {"tools": _mcp_tools()}))
    if method == "tools/call":
        return await _tools_call(req_id, params, request)
    return JSONResponse(_rpc_error(req_id, -32601, f"Method not found: {method}"))


async def _tools_call(req_id: Any, params: dict[str, Any], request: Request) -> Response:
    # Resolve the user from the Authorization header (required for tools/call).
    auth = request.headers.get("authorization") or ""
    if not auth.startswith("Bearer "):
        return JSONResponse(_rpc_error(req_id, -32602, "Missing bearer token"), status_code=401)
    from app.services.users import authenticate_token

    async with SessionLocal() as auth_session:
        auth_user = await authenticate_token(auth_session, auth.removeprefix("Bearer ").strip())
    if auth_user is None:
        return JSONResponse(_rpc_error(req_id, -32602, "Invalid token"), status_code=401)
    uid = auth_user.id
    async with SessionLocal() as privacy_session:
        privacy = await privacy_session.get(LLMSettings, uid)
        if privacy is None or not privacy.allow_mcp_access:
            return JSONResponse(
                _rpc_error(req_id, -32003, "mcp_memory_access_not_allowed"),
                status_code=403,
            )

    name = params.get("name")
    if not isinstance(name, str) or not name:
        return JSONResponse(_rpc_error(req_id, -32602, "Missing tool name"), status_code=400)
    args = params.get("arguments", {})
    if not isinstance(args, dict):
        return JSONResponse(_rpc_error(req_id, -32602, "Arguments must be an object"), status_code=400)
    router_map = {**UNIVERSAL_TOOL_HANDLERS, **tool_router(all_plugins())}
    handler = router_map.get(name)
    if handler is None:
        return JSONResponse(
            _rpc_result(
                req_id,
                {
                    "content": [{"type": "text", "text": json.dumps({"error": f"unknown_tool:{name}"})}],
                    "isError": True,
                },
            )
        )
    try:
        await check_user_quota(uid)
        from app.llm.admission import reserve_request

        async with SessionLocal() as quota_session:
            await reserve_request(quota_session, uid, job=False)
            await quota_session.commit()
    except RateLimitExceeded as exc:
        return JSONResponse(_rpc_error(req_id, -32000, exc.reason), status_code=429,
                            headers={"Retry-After": str(exc.retry_after)})
    async with SessionLocal() as session:
        try:
            out = await _run_tool(handler, session, uid, name, args)
            await session.commit()
        except Exception as exc:  # noqa: BLE001 — tool failures are MCP results, not HTTP errors
            logger.warning("mcp tool %s failed: %s", name, exc)
            await session.rollback()
            out = {"error": "tool_failed", "detail": safe_error(exc)}
    return JSONResponse(
        _rpc_result(
            req_id,
            {
                "content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False, default=str)}],
                "isError": "error" in out,
            },
        )
    )
