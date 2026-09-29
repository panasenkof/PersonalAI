from __future__ import annotations

import json
import logging
import time
from typing import Any, Awaitable, Callable

import httpx
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.history import load_history_messages
from app.agent.universal_tools import UNIVERSAL_TOOL_DEFINITIONS, UNIVERSAL_TOOL_HANDLERS, parse_tool_arguments
from app.config import get_settings
from app.domains.registry import all_plugins, tool_router, tools_openai_format
from app.llm.providers import ChatMessage, LLMProvider, LocalLLMProvider
from app.llm.router import default_model_for_user, local_fallback_target, provider_for_user

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are PIA, a personal assistant with tools over the user's private knowledge base and domain plugins (automotive, medical labs).
Rules:
- Prefer tools over guessing. For factual recall, use kb_search or kb_list_entities.
- When the user asks to remember or log information, persist via kb_create_entity or domain-specific tools, then reply with a short confirmation including record identifiers when available.
- For questions, retrieve from KB first when appropriate.
- Do not claim medical diagnosis. For lab reports: ingest with labs_record_report and
show values with reference ranges only; trends via labs_get_trends — interpretation is
the clinician's job. Automotive guidance is informational only.
- If the user attached a PDF/text document that is not a lab report, call kb_ingest_document with its storage_key.
- Data extracted from photos/documents may need the user's confirmation: when a tool returns status pending_user_confirm, say the record is awaiting confirmation (do not claim it is saved).
- If the user attached images described in the message, use auto_parse_service_receipt when it is a service document and a vehicle_entity_id is known; otherwise ask which vehicle to attach.
- Match the user's language (e.g. Russian)."""

EmitFn = Callable[[dict[str, Any]], Awaitable[None]]

_ARGS_PREVIEW_CHARS = 300


def summarize_tool_result(out: Any) -> tuple[bool, str]:
    """(ok, short human-readable summary) of a tool result for UI step chips."""
    if not isinstance(out, dict):
        return True, str(out)[:120]
    if out.get("error"):
        detail = out.get("detail") or out.get("message") or ""
        return False, f"{out['error']} {detail}".strip()[:160]
    if isinstance(out.get("hits"), list):
        return True, f"{len(out['hits'])} найдено"
    if isinstance(out.get("entities"), list):
        return True, f"{len(out['entities'])} записей"
    if isinstance(out.get("series"), list):
        return True, f"{len(out['series'])} точек"
    for key in ("status", "note"):
        if out.get(key):
            return True, str(out[key])[:160]
    return True, "ok"


async def _chat_step(
    provider: LLMProvider,
    model: str,
    messages: list[ChatMessage],
    tools: list[dict[str, Any]],
    emit: EmitFn | None = None,
) -> tuple[LLMProvider, str, Any, bool]:
    """One LLM turn: streaming when a subscriber listens, fallback chain on errors.

    Returns (provider, model, result, streamed).
    """
    streamed = False
    if emit is not None and getattr(provider, "stream_chat", None) is not None:
        delivered = False
        try:

            async def on_token(piece: str) -> None:
                nonlocal delivered
                delivered = True
                await emit({"type": "token", "content": piece})

            async def on_tool_delta(index: int, name: str, fragment: str) -> None:
                nonlocal delivered
                delivered = True
                await emit({"type": "tool_call", "index": index, "name": name, "arguments_delta": fragment})

            result = await provider.stream_chat(
                messages,
                model=model,
                tools=tools,
                tool_choice="auto",
                on_token=on_token,
                on_tool_delta=on_tool_delta,
            )
            return provider, model, result, bool(result.message.content) and delivered
        except NotImplementedError:
            pass  # provider has no streaming — continue with plain chat
        except (httpx.HTTPError, json.JSONDecodeError):
            if delivered:
                # partial output already reached the client: tell it to discard before we retry
                await emit({"type": "reset"})
            # fall through: plain chat + local→cloud fallback below

    try:
        result = await provider.chat(messages, model=model, tools=tools, tool_choice="auto")
    except (httpx.HTTPError, httpx.TimeoutException, json.JSONDecodeError):
        if isinstance(provider, LocalLLMProvider):
            target = local_fallback_target()
            if target is not None:
                fb_provider, fb_model = target
                if emit is not None and getattr(fb_provider, "stream_chat", None) is not None:
                    try:

                        async def fb_token(piece: str) -> None:
                            await emit({"type": "token", "content": piece})

                        res = await fb_provider.stream_chat(
                            messages, model=fb_model, tools=tools, tool_choice="auto", on_token=fb_token
                        )
                        return fb_provider, fb_model, res, bool(res.message.content)
                    except (NotImplementedError, httpx.HTTPError, json.JSONDecodeError):
                        await emit({"type": "reset"})
                result = await fb_provider.chat(
                    messages, model=fb_model, tools=tools, tool_choice="auto"
                )
                return fb_provider, fb_model, result, streamed
        raise
    if emit is not None and not streamed and result.message.content:
        # no streaming backend: emit the whole answer as a single token event
        await emit({"type": "token", "content": result.message.content})
    return provider, model, result, streamed


async def _run_tool(
    handler: Any, session: AsyncSession, user_id: str, name: str, args: dict[str, Any]
) -> dict[str, Any]:
    """Execute one tool; argument mistakes by the model become tool errors it can correct."""
    try:
        return await handler(session, user_id, args)
    except SQLAlchemyError:
        raise  # broken transaction: fail the job rather than continue on a poisoned session
    except (KeyError, TypeError, ValueError) as exc:
        logger.info("tool %s rejected arguments: %r", name, exc)
        return {"error": "invalid_arguments", "detail": f"{type(exc).__name__}: {exc}"}


async def run_agent(
    session: AsyncSession,
    user_id: str,
    user_visible_text: str,
    conversation_id: str | None = None,
    emit: EmitFn | None = None,
) -> dict[str, Any]:
    plugins = all_plugins()
    tools = UNIVERSAL_TOOL_DEFINITIONS + tools_openai_format(plugins)
    router = {**UNIVERSAL_TOOL_HANDLERS, **tool_router(plugins)}

    provider = await provider_for_user(session, user_id)
    model = await default_model_for_user(session, user_id)

    messages: list[ChatMessage] = [ChatMessage(role="system", content=SYSTEM_PROMPT)]
    if conversation_id:
        window = get_settings().agent_history_window
        messages.extend(await load_history_messages(session, user_id, conversation_id, window=window))
    messages.append(ChatMessage(role="user", content=user_visible_text))

    for _ in range(max(1, get_settings().agent_max_iterations)):
        provider, model, result, streamed = await _chat_step(provider, model, messages, tools, emit)
        msg = result.message
        if msg.tool_calls:
            messages.append(ChatMessage(role="assistant", content=msg.content, tool_calls=msg.tool_calls))
            for tc in msg.tool_calls:
                fn = tc.get("function") or {}
                name = fn.get("name")
                args = parse_tool_arguments(fn.get("arguments"))
                if not name:
                    continue
                if emit is not None:
                    preview = json.dumps(args, ensure_ascii=False, default=str)[:_ARGS_PREVIEW_CHARS]
                    await emit({"type": "tool_start", "name": name, "arguments": preview})
                handler = router.get(name)
                started = time.monotonic()
                if handler is None:
                    out: dict[str, Any] = {"error": f"unknown_tool:{name}"}
                else:
                    out = await _run_tool(handler, session, user_id, name, args)
                tool_payload = json.dumps(out, default=str)
                if emit is not None:
                    ok, summary = summarize_tool_result(out)
                    await emit(
                        {
                            "type": "tool",
                            "name": name,
                            "ok": ok,
                            "summary": summary,
                            "ms": int((time.monotonic() - started) * 1000),
                        }
                    )
                messages.append(
                    ChatMessage(
                        role="tool",
                        tool_call_id=tc.get("id") or "call",
                        name=name,
                        content=tool_payload,
                    )
                )
            continue
        return {"assistant_text": msg.content or "", "raw_last": result.raw}

    return {"assistant_text": "Stopped after tool iteration limit.", "raw_last": {}}
