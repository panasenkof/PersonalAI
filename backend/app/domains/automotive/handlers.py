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
from app.security.redact import safe_error
from app.services.facts import stage_or_commit_observation
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
    from app.rag.indexing import index_observation

    await index_observation(session, user_id, obs)
    return {"observation_id": obs.id, "status": "created"}


async def auto_parse_service_receipt(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    storage_key = args["storage_key"]
    vehicle_entity_id = args.get("vehicle_entity_id")
    from app.services.blobs import user_owns_blob

    if not await user_owns_blob(session, user_id, storage_key):
        return {"error": "unknown_storage_key"}
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
        return {"error": "vision_parse_failed", "detail": safe_error(exc)}
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
    work_items: list[Any] = list(parsed.get("work_items") or [])
    payload: dict[str, Any] = {
        "type": "service_event",
        "odometer_km": parsed.get("odometer_km"),
        "work_items": work_items,
        "vendor": parsed.get("vendor"),
        "source": "receipt_image",
    }
    items = ", ".join(str((w.get("name") if isinstance(w, dict) else w) or "") for w in work_items)
    summary = (
        f"Сервисное событие {occurred.date().isoformat()}: пробег {payload['odometer_km']} км, "
        f"{payload['vendor'] or 'сервис не указан'}; работы: {items or '—'}"
    )
    staged = await stage_or_commit_observation(
        session,
        user_id,
        entity_id=e.id,
        kind="service_event",
        occurred_at=occurred,
        payload=payload,
        summary=summary,
        needs_confirmation=True,  # values were read from a photo by a vision model
    )
    if staged["status"] == "saved":
        return {"observation_id": staged["observation_id"], "parsed": parsed, "status": "saved_to_observations"}
    return {**staged, "parsed": parsed, "note": "Awaiting user confirmation; tell the user to confirm or reject the record."}


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
        return {"error": "web_fetch_failed", "detail": safe_error(exc)}
    abstract = data.get("AbstractText") or ""
    if not abstract:
        rt = data.get("RelatedTopics") or []
        if rt and isinstance(rt[0], dict):
            abstract = str(rt[0].get("Text", ""))
    if not abstract:
        abstract = str(data.get("Answer") or "") or "No abstract returned; refine query manually."
    provider = await provider_for_user(session, user_id)
    model = await default_model_for_user(session, user_id)
    user_prompt = f"Source search summary (may be incomplete):\n{abstract}\n\nExtract only intervals explicitly present in the source. Never infer missing intervals; return empty items if unsupported."
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
    # An already-approved candidate must not create duplicate history entries.
    if cand.status == ScheduleStatus.approved.value:
        return {"status": "approved", "vehicle_entity_id": cand.vehicle_entity_id}
    e = await session.get(Entity, cand.vehicle_entity_id)
    if e is None or e.user_id != user_id:
        return {"error": "vehicle_not_found"}
    merged = dict(e.payload)
    merged["approved_maintenance_schedule"] = cand.structured
    merged["schedule_candidate_id"] = cand.id
    from app.memory.sqlalchemy import SqlAlchemyMemoryRepository
    from app.rag.indexing import reindex_entity

    await SqlAlchemyMemoryRepository(session, user_id).revise_entity(
        e.id, expected_version=e.record_version, payload=merged,
        reason="approve_maintenance_schedule", actor_kind="tool",
    )
    cand.status = ScheduleStatus.approved.value
    await session.refresh(e)
    await reindex_entity(session, user_id, e)
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
    events = list(res.scalars())
    reported = [int(o.payload["odometer_km"]) for o in events if (o.payload or {}).get("odometer_km") is not None]
    if e.payload.get("odometer_km") is not None:
        reported.append(int(e.payload["odometer_km"]))
    current = max(reported) if reported else None
    out = []
    for it in items:
        name = str(it.get("name") or "").strip()
        interval = int(it.get("interval_km") or 0)
        if not name or interval <= 0:
            continue
        item_id = it.get("item_id")
        aliases = {str(n).strip().casefold() for n in [name, *it.get("aliases", [])]}
        last_km = None
        for event in events:
            work = (event.payload or {}).get("work_items") or []
            def matches(value: Any) -> bool:
                if isinstance(value, dict):
                    if item_id and value.get("item_id"):
                        return value["item_id"] == item_id
                    value = value.get("name") or ""
                return str(value).strip().casefold() in aliases
            if any(matches(value) for value in work):
                value = (event.payload or {}).get("odometer_km")
                # Latest matching service with unknown mileage invalidates the baseline.
                last_km = int(value) if value is not None else None
                break
        basis = it.get("basis", "since_last_service")
        baseline = last_km if last_km is not None else it.get("baseline_odometer_km")
        next_at = None
        if basis == "since_last_service" and baseline is not None:
            next_at = int(baseline) + interval
        elif basis == "fixed_milestones" and baseline is not None:
            origin = int(it.get("origin_odometer_km") or 0)
            next_at = origin + max(1, (int(baseline) - origin) // interval + 1) * interval
        remaining = next_at - current if next_at is not None and current is not None else None
        status = "unknown_history" if next_at is None else "unknown_odometer" if current is None else "overdue" if remaining is not None and remaining < 0 else "due" if remaining == 0 else "scheduled"
        out.append({"item": name, "item_id": item_id, "basis": basis, "status": status,
                    "next_odometer_km_target": next_at, "km_until_due": remaining,
                    "last_service_odometer_km": last_km})
    return {"vehicle_entity_id": e.id, "current_odometer_km": current, "items": out}
