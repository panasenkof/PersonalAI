from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.history import get_conversation_messages, list_conversations
from app.api.deps import get_current_user
from app.api.schemas import ChatTurnOut, ConversationOut
from app.db import get_session
from app.models import ChatTurn, Conversation, User

router = APIRouter(prefix="/v1/conversations", tags=["conversations"])


@router.get("", response_model=list[ConversationOut])
async def list_convs(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[ConversationOut]:
    rows = await list_conversations(session, user.id)
    return [
        ConversationOut(
            id=c.id, channel=c.channel, title=c.title, created_at=c.created_at, updated_at=c.updated_at
        )
        for c in rows
    ]


@router.get("/{conversation_id}/messages", response_model=list[ChatTurnOut])
async def conv_messages(
    conversation_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[ChatTurnOut]:
    convs = await list_conversations(session, user.id)
    if conversation_id not in {c.id for c in convs}:
        raise HTTPException(status_code=404, detail="conversation_not_found")
    turns = await get_conversation_messages(session, user.id, conversation_id)
    return [ChatTurnOut(role=t.role, content=t.content, created_at=t.created_at) for t in turns]


@router.delete("/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Delete a conversation and its turns (explicit turn delete keeps SQLite happy)."""
    conv = await session.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(status_code=404, detail="conversation_not_found")
    await session.execute(delete(ChatTurn).where(ChatTurn.conversation_id == conversation_id))
    await session.delete(conv)
    await session.commit()
    return {"status": "deleted", "id": conversation_id}
