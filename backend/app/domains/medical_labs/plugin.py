from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.base import DomainPlugin


async def health_record_stub(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    _ = session
    return {
        "status": "stub",
        "message": "Medical labs domain is not enabled in this build; use kb_create_entity with domain medical_labs manually.",
        "received": args,
    }


def medical_labs_plugin() -> DomainPlugin:
    tools: list[dict[str, Any]] = [
        {
            "type": "function",
            "function": {
                "name": "medical_labs_stub",
                "description": "Placeholder for future lab ingestion; returns guidance only.",
                "parameters": {
                    "type": "object",
                    "properties": {"note": {"type": "string"}},
                    "required": [],
                    "additionalProperties": False,
                },
            },
        }
    ]
    return DomainPlugin(
        domain_id="medical_labs",
        description="Stub for medical analyses domain.",
        tool_definitions=tools,
        tool_handlers={"medical_labs_stub": health_record_stub},
    )
