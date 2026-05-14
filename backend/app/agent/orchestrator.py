from __future__ import annotations

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.universal_tools import UNIVERSAL_TOOL_DEFINITIONS, UNIVERSAL_TOOL_HANDLERS, parse_tool_arguments
from app.domains.registry import all_plugins, tools_openai_format, tool_router
from app.llm.providers import ChatMessage
from app.llm.router import default_model_for_user, provider_for_user


SYSTEM_PROMPT = """You are PIA, a personal assistant with tools over the user's private knowledge base and domain plugins (automotive, medical stub).
Rules:
- Prefer tools over guessing. For factual recall, use kb_search or kb_list_entities.
- When the user asks to remember or log information, persist via kb_create_entity or domain-specific tools, then reply with a short confirmation including record identifiers when available.
- For questions, retrieve from KB first when appropriate.
- Do not claim medical diagnosis. Automotive guidance is informational only.
- If the user attached images described in the message, use auto_parse_service_receipt when it is a service document and a vehicle_entity_id is known; otherwise ask which vehicle to attach.
- Match the user's language (e.g. Russian)."""


async def run_agent(
    session: AsyncSession,
    user_id: str,
    user_visible_text: str,
) -> dict[str, Any]:
    plugins = all_plugins()
    tools = UNIVERSAL_TOOL_DEFINITIONS + tools_openai_format(plugins)
    router = {**UNIVERSAL_TOOL_HANDLERS, **tool_router(plugins)}

    provider = await provider_for_user(session, user_id)
    model = await default_model_for_user(session, user_id)

    messages: list[ChatMessage] = [
        ChatMessage(role="system", content=SYSTEM_PROMPT),
        ChatMessage(role="user", content=user_visible_text),
    ]

    for _ in range(10):
        result = await provider.chat(messages, model=model, tools=tools, tool_choice="auto")
        msg = result.message
        if msg.tool_calls:
            messages.append(ChatMessage(role="assistant", content=msg.content, tool_calls=msg.tool_calls))
            for tc in msg.tool_calls:
                fn = tc.get("function") or {}
                name = fn.get("name")
                args = parse_tool_arguments(fn.get("arguments"))
                if not name:
                    continue
                handler = router.get(name)
                if handler is None:
                    tool_payload = json.dumps({"error": f"unknown_tool:{name}"})
                else:
                    out = await handler(session, user_id, args)
                    tool_payload = json.dumps(out, default=str)
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
