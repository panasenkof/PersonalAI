"""Embedding compatibility includes provider, model and operator-controlled revision."""
import hashlib
import json

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import LLMSettings


async def embedding_space(session: AsyncSession, user_id: str) -> str:
    row = await session.get(LLMSettings, user_id)
    settings = get_settings()
    identity = [row.provider_kind if row else "cloud",
                (row.base_url if row else "https://api.openai.com/v1").rstrip("/"),
                (row.embedding_model if row else None) or settings.default_embedding_model,
                settings.embedding_revision]
    return hashlib.sha256(json.dumps(identity).encode()).hexdigest()
