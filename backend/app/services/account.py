from __future__ import annotations

import io
import json
import os
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

from cryptography.fernet import InvalidToken
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import SessionLocal
from app.models import (
    Base,
    Blob,
    BlobDeletion,
    ChatTurn,
    Chunk,
    Collection,
    Conversation,
    Entity,
    ExtractedFact,
    IngestionJob,
    LLMSettings,
    Observation,
    ReminderNotification,
    ScheduleCandidate,
    User,
    UserDailyUsage,
)
from app.security.crypto import require_decryption
from app.security.journal import append_deletion
from app.storage.blob import read_bytes, resolve_storage_path

_EXPORT_MODELS = [Collection, Entity, Observation, ExtractedFact, Conversation, ChatTurn, ScheduleCandidate, ReminderNotification, IngestionJob, Blob, Chunk, UserDailyUsage]
_EXCLUDE = {'embedding', 'embedding_vec'}


async def export_account(session: AsyncSession, user: User) -> bytes:
    limit = get_settings().account_export_max_bytes
    data: dict[str, Any] = {'format_version': 1, 'account': {'email': user.email, 'created_at': user.created_at.isoformat(), 'email_verified': user.email_verified}, 'data': {}}
    blobs = list((await session.scalars(select(Blob).where(Blob.user_id == user.id))).all())
    if sum(blob.size_bytes for blob in blobs) > limit:
        raise HTTPException(413, detail='export_too_large_contact_support')
    with require_decryption():
        for model in _EXPORT_MODELS:
            rows = (await session.scalars(select(model).where(model.__table__.c.user_id == user.id))).all()
            data['data'][model.__tablename__] = [{column.name: getattr(row, column.name) for column in model.__table__.columns if column.name not in _EXCLUDE} for row in rows]
        llm = await session.get(LLMSettings, user.id)
        data['llm'] = {field: getattr(llm, field) for field in ['provider_kind', 'base_url', 'default_model', 'embedding_model', 'supports_vision']} if llm else None
        content = json.dumps(data, ensure_ascii=False, default=lambda value: value.isoformat() if isinstance(value, datetime) else str(value)).encode()
        if len(content) + sum(blob.size_bytes for blob in blobs) > limit:
            raise HTTPException(413, detail='export_too_large_contact_support')
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('account.json', content)
            for blob in blobs:
                safe_name = re.sub(r'[^\w. -]', '_', os.path.basename(blob.filename or 'file.bin'))[:100]
                try:
                    raw = await read_bytes(blob.storage_key)
                except (OSError, ValueError, InvalidToken, RuntimeError):
                    raise HTTPException(409, detail='export_file_unavailable_contact_support') from None
                archive.writestr(f'files/{blob.id}-{safe_name}', raw)
    return buffer.getvalue()


async def delete_account(session: AsyncSession, user: User) -> None:
    # Serialise against child writes: PostgreSQL FK inserts hold a KEY SHARE lock.
    locked = await session.scalar(select(User.id).where(User.id == user.id).with_for_update())
    if locked is None:
        raise HTTPException(401, detail='session_expired')
    active = await session.scalar(select(IngestionJob.id).where(IngestionJob.user_id == user.id, IngestionJob.status.in_(['accepted', 'processing'])).limit(1))
    if active:
        raise HTTPException(409, detail='stop_active_jobs_before_deleting')
    keys = list((await session.scalars(select(Blob.storage_key).where(Blob.user_id == user.id))).all())
    for key in keys:
        session.add(BlobDeletion(storage_key=key))
    await session.flush()
    # Core deletes avoid ORM relationships trying to NULL non-null foreign keys.
    # All currently mapped owned tables have user_id; reverse dependency order also works on SQLite.
    for table in reversed(Base.metadata.sorted_tables):
        if 'user_id' in table.c:
            await session.execute(delete(table).where(table.c.user_id == user.id))
    await session.execute(delete(User).where(User.id == user.id))
    # Write-ahead journal deliberately survives database backup/restore. A failed commit
    # may over-delete during disaster recovery, but cannot resurrect deleted personal data.
    journal = get_settings().deletion_journal_path
    if journal:
        try:
            append_deletion(Path(journal), user.id)
        except OSError:
            await session.rollback()
            raise HTTPException(503, detail='deletion_journal_unavailable_retry_later') from None
    await session.commit()


async def cleanup_deleted_blobs() -> int:
    removed = 0
    async with SessionLocal() as session:
        rows = (await session.scalars(select(BlobDeletion).limit(100))).all()
        for row in rows:
            # Never unlink a file still owned by a live account.
            owner = await session.scalar(select(Blob.id).where(Blob.storage_key == row.storage_key))
            if owner:
                continue
            try:
                os.unlink(resolve_storage_path(row.storage_key))
            except FileNotFoundError:
                pass
            except OSError:
                continue
            await session.execute(delete(BlobDeletion).where(BlobDeletion.storage_key == row.storage_key))
            await session.commit()
            removed += 1
    return removed
