from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Blob
from app.storage.blob import save_bytes


async def store_blob(
    session: AsyncSession,
    user_id: str,
    data: bytes,
    mime: str,
    filename: str | None = None,
) -> Blob:
    """Persist file bytes and record ownership so later access can be checked."""
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
    await session.flush()
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
