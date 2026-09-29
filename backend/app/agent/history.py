from __future__ import annotations

from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.llm.providers import ChatMessage
from app.models import ChatTurn, Conversation, utcnow

# How many raw turns are sent to the LLM; older turns are compacted into one note.
DEFAULT_HISTORY_WINDOW = 20


async def get_or_create_conversation(
    session: AsyncSession,
    user_id: str,
    channel: str,
    conversation_id: str | None = None,
) -> Conversation | None:
    if conversation_id:
        res = await session.execute(
            select(Conversation)
            .where(Conversation.id == conversation_id)
            .where(Conversation.user_id == user_id)
        )
        return res.scalar_one_or_none()
    conv = Conversation(user_id=user_id, channel=channel)
    session.add(conv)
    await session.flush()
    return conv


async def list_conversations(session: AsyncSession, user_id: str) -> list[Conversation]:
    res = await session.execute(
        select(Conversation)
        .where(Conversation.user_id == user_id)
        .order_by(Conversation.updated_at.desc())
    )
    return list(res.scalars().all())


async def get_conversation_messages(
    session: AsyncSession, user_id: str, conversation_id: str
) -> list[ChatTurn]:
    res = await session.execute(
        select(ChatTurn)
        .where(ChatTurn.conversation_id == conversation_id)
        .where(ChatTurn.user_id == user_id)
        .order_by(ChatTurn.created_at.asc())
    )
    return list(res.scalars().all())


async def load_history_messages(
    session: AsyncSession,
    user_id: str,
    conversation_id: str,
    window: int | None = None,
) -> list[ChatMessage]:
    """Recent turns as ChatMessages; older turns compacted into one system note."""
    window = window or DEFAULT_HISTORY_WINDOW
    turns = await get_conversation_messages(session, user_id, conversation_id)
    if not turns:
        return []
    recent = turns[-window:]
    older = turns[:-window]
    out: list[ChatMessage] = []
    if older:
        tail = "; ".join(f"{t.role}: {t.content[:200]}" for t in older[-10:])
        out.append(
            ChatMessage(
                role="system",
                content=f"[Компактная история более ранних сообщений] {tail}",
            )
        )
    for t in recent:
        role: Literal["user", "assistant"] = "user" if t.role == "user" else "assistant"
        out.append(ChatMessage(role=role, content=t.content))
    return out


async def persist_turn(
    session: AsyncSession,
    user_id: str,
    conversation_id: str,
    user_content: str,
    assistant_content: str,
) -> None:
    session.add(ChatTurn(conversation_id=conversation_id, user_id=user_id, role="user", content=user_content))
    session.add(
        ChatTurn(
            conversation_id=conversation_id,
            user_id=user_id,
            role="assistant",
            content=assistant_content,
        )
    )
    conv = await session.get(Conversation, conversation_id)
    if conv is not None:
        conv.updated_at = utcnow()
        if not conv.title:
            conv.title = user_content.strip().replace("\n", " ")[:80]
    await session.flush()
