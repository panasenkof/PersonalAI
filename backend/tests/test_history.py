from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.history import get_or_create_conversation, load_history_messages, persist_turn
from app.llm.providers import ChatMessage, LLMCompletionResult
from app.models import Base, User


async def _mk_session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


class FakeProvider:
    """Records every messages list passed to chat(); returns plain text."""

    def __init__(self):
        self.calls: list[list[ChatMessage]] = []

    async def chat(self, messages, *, model, tools=None, tool_choice=None, temperature=0.2):
        self.calls.append(list(messages))
        return LLMCompletionResult(
            message=ChatMessage(role="assistant", content=f"echo-{len(self.calls)}"),
            raw={},
        )


@pytest.mark.asyncio
async def test_history_window_and_compaction() -> None:
    Session = await _mk_session_factory()
    async with Session() as session:
        u = User(email="h@test.dev", password_hash="x")
        session.add(u)
        await session.flush()
        conv = await get_or_create_conversation(session, u.id, "mobile")
        for i in range(30):
            await persist_turn(session, u.id, conv.id, f"q{i}", f"a{i}")
        await session.commit()

    async with Session() as session:
        msgs = await load_history_messages(session, u.id, conv.id, window=20)
        # 1 compaction system note + 20 recent turns
        assert len(msgs) == 21
        assert msgs[0].role == "system"
        assert "Компактная история" in (msgs[0].content or "")
        # most recent turn is the last one
        assert msgs[-1].content == "a29"
        assert msgs[-2].content == "q29"

        short = await load_history_messages(session, u.id, conv.id, window=100)
        assert len(short) == 60
        assert all(m.role in ("user", "assistant") for m in short)


@pytest.mark.asyncio
async def test_persist_turn_sets_title() -> None:
    Session = await _mk_session_factory()
    async with Session() as session:
        u = User(email="t@test.dev", password_hash="x")
        session.add(u)
        await session.flush()
        conv = await get_or_create_conversation(session, u.id, "telegram")
        await persist_turn(session, u.id, conv.id, "Запомни пробег 120000", "Сохранено")
        await session.commit()
        assert conv.title == "Запомни пробег 120000"
