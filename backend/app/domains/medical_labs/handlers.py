from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.medical_labs.schemas import LAB_REPORT_SCHEMA
from app.llm.router import default_model_for_user, provider_for_user
from app.models import Collection, Entity, Observation
from app.rag.indexing import index_entity
from app.security.redact import safe_error
from app.services.documents import extract_pdf_text
from app.services.facts import stage_or_commit_observation

logger = logging.getLogger(__name__)


async def _find_or_create_profile(session: AsyncSession, user_id: str) -> Entity:
    res = await session.execute(
        select(Entity).where(Entity.user_id == user_id).where(Entity.domain == "medical_labs")
    )
    for e in res.scalars().all():
        if (e.payload or {}).get("type") == "lab_profile":
            return e
    col_res = await session.execute(
        select(Collection).where(Collection.user_id == user_id).where(Collection.slug == "health")
    )
    col = col_res.scalar_one_or_none()
    if col is None:
        all_cols = await session.execute(
            select(Collection).where(Collection.user_id == user_id).limit(1)
        )
        col = all_cols.scalar_one()
    e = Entity(
        user_id=user_id,
        collection_id=col.id,
        domain="medical_labs",
        schema_version="1",
        payload={"type": "lab_profile", "title": "Лабораторные анализы"},
    )
    session.add(e)
    await session.flush()
    await index_entity(session, user_id, e)
    return e


async def labs_record_report(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """Ingest a lab report (text, PDF or image) as a time-bound observation."""
    from app.services.blobs import user_owns_blob
    from app.storage.blob import read_bytes

    text: str | None = args.get("text")
    structured: dict[str, Any] | None = None
    storage_key = args.get("storage_key")
    mime = (args.get("mime") or "").lower()
    from_file = bool(storage_key)  # values read from a file/photo need user confirmation

    if storage_key:
        if not await user_owns_blob(session, user_id, storage_key):
            return {"error": "unknown_storage_key"}
        data = await read_bytes(storage_key)
        if "pdf" in mime or storage_key.lower().endswith(".pdf"):
            text = extract_pdf_text(data)
        elif mime.startswith("image/"):
            provider = await provider_for_user(session, user_id)
            model = await default_model_for_user(session, user_id)
            import base64

            try:
                structured = await provider.vision_json(
                    model=model,
                    system="Extract structured lab report fields. Do not interpret or diagnose.",
                    user_text="Return JSON matching the schema.",
                    image_url=None,
                    image_base64=base64.b64encode(data).decode("ascii"),
                    mime=mime or "image/jpeg",
                    json_schema_name="lab_report",
                    json_schema=LAB_REPORT_SCHEMA,
                )
            except Exception as exc:  # noqa: BLE001
                return {"error": "vision_parse_failed", "detail": safe_error(exc)}
        else:
            text = data.decode("utf-8", errors="replace")

    if structured is None:
        if not text or not text.strip():
            return {"error": "no_input", "message": "Provide text or a storage_key."}
        provider = await provider_for_user(session, user_id)
        model = await default_model_for_user(session, user_id)
        try:
            structured = await provider.text_json_schema(
                model=model,
                system=(
                    "Extract lab analytes exactly as printed. Values are strings. "
                    "Never diagnose, never comment — extraction only."
                ),
                user=text[:12000],
                json_schema_name="lab_report",
                json_schema=LAB_REPORT_SCHEMA,
            )
        except Exception as exc:  # noqa: BLE001
            return {"error": "extract_failed", "detail": safe_error(exc)}

    occurred_raw = args.get("occurred_at") or structured.get("collected_at")
    try:
        occurred = (
            datetime.fromisoformat(str(occurred_raw).replace("Z", "+00:00"))
            if occurred_raw
            else datetime.now(timezone.utc)
        )
        if occurred.tzinfo is None:
            occurred = occurred.replace(tzinfo=timezone.utc)
    except ValueError:
        occurred = datetime.now(timezone.utc)

    profile = await _find_or_create_profile(session, user_id)
    analytes: list[dict[str, Any]] = list(structured.get("analytes") or [])
    payload: dict[str, Any] = {
        "type": "lab_report",
        "panel_name": structured.get("panel_name"),
        "lab_name": structured.get("lab_name"),
        "analytes": analytes,
        "disclaimer": "Informational only; not a substitute for a clinician.",
    }
    lines = []
    for a in analytes[:12]:
        lines.append(f"{a.get('name')}: {a.get('value')} {a.get('unit') or ''}".strip())
    summary = f"Анализы {occurred.date().isoformat()} ({payload['panel_name'] or 'панель'}): " + (
        "; ".join(lines) or "показатели не распознаны"
    )
    staged = await stage_or_commit_observation(
        session,
        user_id,
        entity_id=profile.id,
        kind="lab_report",
        occurred_at=occurred,
        payload=payload,
        summary=summary,
        needs_confirmation=from_file,
    )
    if staged["status"] != "saved":
        return {**staged, "analytes_count": len(analytes), "note": "Awaiting user confirmation."}
    return {
        "observation_id": staged["observation_id"],
        "panel_name": payload.get("panel_name"),
        "analytes_count": len(analytes),
        "status": "saved",
    }


async def labs_get_trends(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """Deterministic time series for one analyte across stored lab reports."""
    query = str(args.get("analyte") or "").strip().lower()
    if not query:
        return {"error": "no_analyte"}
    res = await session.execute(
        select(Observation)
        .where(Observation.user_id == user_id)
        .where(Observation.kind == "lab_report")
        .order_by(Observation.occurred_at.asc())
    )
    series: list[dict[str, Any]] = []
    for obs in res.scalars().all():
        for a in (obs.payload or {}).get("analytes") or []:
            name = str(a.get("name") or "")
            if query not in name.lower() and name.lower() not in query:
                continue
            value = None
            try:
                value = float(str(a.get("value")).replace(",", "."))
            except (TypeError, ValueError):
                value = a.get("value")
            series.append(
                {
                    "date": obs.occurred_at.date().isoformat(),
                    "analyte": name,
                    "value": value,
                    "unit": a.get("unit"),
                    "flag": a.get("flag", "unknown"),
                }
            )
    if not series:
        return {"analyte": args.get("analyte"), "series": [], "note": "no data"}
    return {"analyte": args.get("analyte"), "series": series}
