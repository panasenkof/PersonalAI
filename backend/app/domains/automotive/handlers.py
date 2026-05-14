from __future__ import annotations

import base64
from datetime import datetime, timezone
from typing import Any

from urllib.parse import quote

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.automotive.schemas import MAINTENANCE_ITEMS_SCHEMA, SERVICE_RECEIPT_SCHEMA
from app.llm.router import default_model_for_user, provider_for_user
from app.models import Entity, Observation, ScheduleCandidate, ScheduleStatus
from app.storage.blob import read_bytes


async def _get_vehicle(session: AsyncSession, user_id: str, vehicle_entity_id: str) -> Entity | None:
    e = await session.get(Entity, vehicle_entity_id)
    if not e or e.user_id != user_id or e.domain != "automotive":
        return None
    if e.payload.get("type") != "vehicle":
        return None
    return e


async def auto_add_vehicle(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    from app.agent.universal_tools import kb_create_entity

    payload = {
        "type": "vehicle",
        "make": args.get("make"),
        "model": args.get("model"),
        "year": args.get("year"),
        "vin": args.get("vin"),
        "odometer_km": args.get("odometer_km"),
    }
    return await kb_create_entity(
        session,
        user_id,
        {
            "collection_slug": args.get("collection_slug") or "garage",
            "domain": "automotive",
            "schema_version": "1",
            "payload": payload,
        },
    )


async def auto_add_service_event(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    e = await _get_vehicle(session, user_id, args["vehicle_entity_id"])
    if not e:
        return {"error": "vehicle_not_found"}
    occurred = datetime.fromisoformat(args["occurred_at"].replace("Z", "+00:00"))
    if occurred.tzinfo is None:
        occurred = occurred.replace(tzinfo=timezone.utc)
    obs = Observation(
        user_id=user_id,
        entity_id=e.id,
        occurred_at=occurred,
        kind="service_event",
        payload={
            "type": "service_event",
            "odometer_km": args.get("odometer_km"),
            "work_items": args.get("work_items") or [],
            "notes": args.get("notes"),
        },
    )
    session.add(obs)
    await session.flush()
    return {"observation_id": obs.id, "status": "created"}


async def auto_parse_service_receipt(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    storage_key = args["storage_key"]
    vehicle_entity_id = args.get("vehicle_entity_id")
    data = await read_bytes(storage_key)
    b64 = base64.b64encode(data).decode("ascii")
    provider = await provider_for_user(session, user_id)
    model = await default_model_for_user(session, user_id)
    mime = args.get("mime") or "image/jpeg"
    try:
        parsed = await provider.vision_json(
            model=model,
            system="Extract structured fields from an automotive service receipt or work order.",
            user_text="Return JSON matching the schema.",
            image_url=None,
            image_base64=b64,
            mime=mime,
            json_schema_name="service_receipt",
            json_schema=SERVICE_RECEIPT_SCHEMA,
        )
    except Exception as exc:  # noqa: BLE001
        return {"error": "vision_parse_failed", "detail": str(exc)}
    e = await session.get(Entity, vehicle_entity_id) if vehicle_entity_id else None
    if not e or e.user_id != user_id:
        return {"parsed": parsed, "note": "No vehicle linked; not persisted as observation."}
    occurred_raw = parsed.get("service_date")
    try:
        occurred = datetime.fromisoformat(str(occurred_raw).replace("Z", "+00:00")) if occurred_raw else datetime.now(timezone.utc)
        if occurred.tzinfo is None:
            occurred = occurred.replace(tzinfo=timezone.utc)
    except Exception:
        occurred = datetime.now(timezone.utc)
    obs = Observation(
        user_id=user_id,
        entity_id=e.id,
        occurred_at=occurred,
        kind="service_event",
        payload={
            "type": "service_event",
            "odometer_km": parsed.get("odometer_km"),
            "work_items": parsed.get("work_items") or [],
            "vendor": parsed.get("vendor"),
            "source": "receipt_image",
        },
    )
    session.add(obs)
    await session.flush()
    return {"observation_id": obs.id, "parsed": parsed, "status": "saved_to_observations"}


async def auto_fetch_maintenance_schedule(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    e = await _get_vehicle(session, user_id, args["vehicle_entity_id"])
    if not e:
        return {"error": "vehicle_not_found"}
    p = e.payload
    q = f"{p.get('year','')} {p.get('make','')} {p.get('model','')} factory recommended maintenance schedule intervals"
    url = "https://api.duckduckgo.com/"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(url, params={"q": q, "format": "json"})
            r.raise_for_status()
            data = r.json()
    except Exception as exc:  # noqa: BLE001
        return {"error": "web_fetch_failed", "detail": str(exc)}
    abstract = data.get("AbstractText") or ""
    if not abstract:
        rt = data.get("RelatedTopics") or []
        if rt and isinstance(rt[0], dict):
            abstract = str(rt[0].get("Text", ""))
    if not abstract:
        abstract = str(data.get("Answer") or "") or "No abstract returned; refine query manually."
    provider = await provider_for_user(session, user_id)
    model = await default_model_for_user(session, user_id)
    user_prompt = f"Source search summary (may be incomplete):\n{abstract}\n\nInfer typical OEM-style interval items; if unknown use conservative estimates and say so in source_summary."
    try:
        structured = await provider.text_json_schema(
            model=model,
            system="You convert noisy web snippets into a structured maintenance schedule. Use integers for intervals.",
            user=user_prompt,
            json_schema_name="maint_items",
            json_schema=MAINTENANCE_ITEMS_SCHEMA,
        )
    except Exception:
        structured = {"items": [], "source_summary": abstract[:2000]}
    cand = ScheduleCandidate(
        user_id=user_id,
        vehicle_entity_id=e.id,
        source_url=f"https://api.duckduckgo.com/?q={quote(q)}",
        structured=structured,
        status=ScheduleStatus.draft.value,
    )
    session.add(cand)
    await session.flush()
    return {"schedule_candidate_id": cand.id, "status": "draft", "structured": structured}


async def auto_approve_schedule(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    cand = await session.get(ScheduleCandidate, args["schedule_candidate_id"])
    if not cand or cand.user_id != user_id:
        return {"error": "candidate_not_found"}
    cand.status = ScheduleStatus.approved.value
    e = await session.get(Entity, cand.vehicle_entity_id)
    if e:
        merged = dict(e.payload)
        merged["approved_maintenance_schedule"] = cand.structured
        merged["schedule_candidate_id"] = cand.id
        e.payload = merged
    await session.flush()
    return {"status": "approved", "vehicle_entity_id": cand.vehicle_entity_id}


async def auto_compute_next_due(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    e = await _get_vehicle(session, user_id, args["vehicle_entity_id"])
    if not e:
        return {"error": "vehicle_not_found"}
    sched = e.payload.get("approved_maintenance_schedule") or {}
    items = sched.get("items") or []
    res = await session.execute(
        select(Observation)
        .where(Observation.entity_id == e.id)
        .where(Observation.kind == "service_event")
        .order_by(Observation.occurred_at.desc())
    )
    last = res.scalars().first()
    last_km = (last.payload or {}).get("odometer_km") if last else e.payload.get("odometer_km")
    last_km = int(last_km or 0)
    current = int(e.payload.get("odometer_km") or last_km or 0)
    out = []
    for it in items:
        name = it.get("name")
        interval = int(it.get("interval_km") or 0)
        if interval <= 0:
            continue
        base = last_km if last_km else current
        next_at = ((base // interval) + 1) * interval
        due_km = max(0, next_at - current)
        out.append({"item": name, "next_odometer_km_target": next_at, "km_until_due": due_km})
    return {"vehicle_entity_id": e.id, "current_odometer_km": current, "items": out}
