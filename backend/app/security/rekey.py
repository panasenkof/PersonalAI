"""Re-encrypt stored secrets with the *first* key in PIA_AGENT_SECRET.

Use after rotating keys (new key first, old one kept behind it) or after enabling encryption
on an existing installation (plaintext rows/files are encrypted too):

    python -m app.security.rekey
"""

from __future__ import annotations

import asyncio
import os

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from app.config import get_settings
from app.db import SessionLocal
from app.models import ChatTurn, ExtractedFact, IngestionJob, LLMSettings, User
from app.security.crypto import (
    BLOB_MAGIC,
    decrypt_api_key,
    decrypt_bytes,
    encrypt_api_key,
    encrypt_bytes,
    encryption_enabled,
    require_decryption,
)


async def rekey_database() -> dict[str, int]:
    if not encryption_enabled():
        raise RuntimeError("PIA_AGENT_SECRET is required for rekey")
    with require_decryption():
        return await _rekey_database()


async def _rekey_database() -> dict[str, int]:
    counts = {"chat_turns": 0, "totp_secrets": 0, "llm_keys": 0, "jobs": 0, "facts": 0}
    async with SessionLocal() as session:
        # EncryptedText decrypts on load and encrypts on flush: marking the attribute dirty rewrites it.
        turns = (await session.execute(select(ChatTurn))).scalars().all()
        for t in turns:
            flag_modified(t, "content")
            counts["chat_turns"] += 1
        for u in (await session.execute(select(User).where(User.totp_secret.is_not(None)))).scalars():
            flag_modified(u, "totp_secret")
            counts["totp_secrets"] += 1
        for job in (await session.execute(select(IngestionJob))).scalars().all():
            flag_modified(job, "envelope")
            if job.result is not None:
                flag_modified(job, "result")
            counts["jobs"] += 1
        for fact in (await session.execute(select(ExtractedFact))).scalars().all():
            flag_modified(fact, "payload")
            counts["facts"] += 1
        for row in (await session.execute(select(LLMSettings))).scalars():
            plain = decrypt_api_key(row.api_key_ciphertext, row.api_key_plain)
            if plain:
                row.api_key_ciphertext, row.api_key_plain = encrypt_api_key(plain)
                counts["llm_keys"] += 1
        await session.commit()
    return counts


def rekey_blobs() -> int:
    base = get_settings().blob_storage_dir
    n = 0
    for root, _dirs, files in os.walk(base):
        for name in files:
            path = os.path.join(root, name)
            with open(path, "rb") as f:
                raw = f.read()
            new = encrypt_bytes(decrypt_bytes(raw))
            if new != raw or raw.startswith(BLOB_MAGIC):
                tmp = path + ".tmp"
                with open(tmp, "wb") as f:
                    f.write(new)
                os.replace(tmp, path)
                n += 1
    return n


async def main() -> None:
    if not encryption_enabled():
        raise SystemExit("PIA_AGENT_SECRET is not set: nothing to encrypt with")
    print("database:", await rekey_database())
    print("blobs re-encrypted:", rekey_blobs())


if __name__ == "__main__":
    asyncio.run(main())
