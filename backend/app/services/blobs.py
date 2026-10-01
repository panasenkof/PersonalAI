from __future__ import annotations

import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Blob, User
from app.storage.blob import resolve_storage_path, save_bytes


async def store_blob(
    session: AsyncSession,
    user_id: str,
    data: bytes,
    mime: str,
    filename: str | None = None,
) -> Blob:
    """Persist file bytes and record ownership so later access can be checked."""
    # Lock before writing bytes so account deletion cannot miss a concurrent upload.
    owner = await session.scalar(select(User.id).where(User.id == user_id).with_for_update(key_share=True, read=True))
    if owner is None:
        from fastapi import HTTPException
        raise HTTPException(401, detail="session_expired")
    key, sha, size = save_bytes(data, mime)
    blob = Blob(
        user_id=user_id,
        storage_key=key,
        sha256=sha,
        mime=mime,
        size_bytes=size,
        filename=filename,
    )
    session.add(blob)
    try:
        await session.flush()
    except Exception:
        os.unlink(resolve_storage_path(key))
        raise
    return blob


async def user_owns_blob(session: AsyncSession, user_id: str, storage_key: str) -> bool:
    res = await session.execute(
        select(Blob.id).where(Blob.user_id == user_id).where(Blob.storage_key == storage_key)
    )
    return res.scalar_one_or_none() is not None


async def get_blob(session: AsyncSession, user_id: str, storage_key: str) -> Blob | None:
    res = await session.execute(
        select(Blob).where(Blob.user_id == user_id).where(Blob.storage_key == storage_key)
    )
    return res.scalar_one_or_none()
