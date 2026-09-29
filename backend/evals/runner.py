from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.orchestrator import run_agent
from app.llm.providers import ChatMessage, LLMCompletionResult
from app.models import Base, Entity, Observation
from app.services.users import bootstrap_user
from evals.golden import GOLDEN


class ScriptedProvider:
    """Pops one scripted reply per chat() call; records every transcript."""

    def __init__(self, script: list[dict[str, Any]]):
        self.script = list(script)
        self.transcripts: list[list[ChatMessage]] = []

    async def chat(self, messages, *, model, tools=None, tool_choice=None, temperature=0.2):
        self.transcripts.append(list(messages))
        step = self.script.pop(0) if self.script else {"final": "(script exhausted)"}
        if "tool" in step:
            tc = {
                "id": f"call_{len(self.transcripts)}",
                "type": "function",
                "function": {"name": step["tool"], "arguments": json.dumps(step.get("args") or {})},
            }
            return LLMCompletionResult(
                message=ChatMessage(role="assistant", content=None, tool_calls=[tc]),
                raw={},
            )
        return LLMCompletionResult(
            message=ChatMessage(role="assistant", content=step.get("final", "")), raw={}
        )

    async def embed(self, texts, *, model):
        raise RuntimeError("embeddings disabled in scripted evals")

    async def text_json_schema(self, *, model, system, user, json_schema_name, json_schema):
        """Deterministic extraction: 'Name: <num> <unit>' patterns from the report text."""
        import re

        analytes = []
        for m in re.finditer(
            r"([А-Яа-яA-Za-zЁё]+):\s*([0-9]+[.,][0-9]+|[0-9]+)\s*([а-яA-Za-z/]+)?", user
        ):
            analytes.append(
                {
                    "name": m.group(1),
                    "value": (m.group(2) or "").replace(",", "."),
                    "unit": m.group(3) or "",
                    "flag": "unknown",
                }
            )
        return {"panel_name": "eval-panel", "analytes": analytes}

    async def stream_chat(self, *a, **kw):
        raise NotImplementedError

    def executed_tools(self) -> list[str]:
        # Transcripts are cumulative message lists — the last one has every
        # tool result so far, so we read tool names from it only.
        if not self.transcripts:
            return []
        return [m.name for m in self.transcripts[-1] if m.role == "tool" and m.name]


# --- post-condition checks -------------------------------------------------


async def _entities(session, uid) -> list[Entity]:
    return list((await session.execute(select(Entity).where(Entity.user_id == uid))).scalars())


async def _observations(session, uid) -> list[Observation]:
    return list(
        (await session.execute(select(Observation).where(Observation.user_id == uid))).scalars()
    )


async def _check_vehicle(session: AsyncSession, uid: str, p: ScriptedProvider) -> bool:
    return any(
        e.domain == "automotive" and (e.payload or {}).get("type") == "vehicle"
        for e in await _entities(session, uid)
    )


async def _check_note(session: AsyncSession, uid: str, p: ScriptedProvider) -> bool:
    return any(e.domain == "notes" for e in await _entities(session, uid))


async def _check_kb_search(session: AsyncSession, uid: str, p: ScriptedProvider) -> bool:
    return "kb_search" in p.executed_tools()


async def _check_lab_obs(session: AsyncSession, uid: str, p: ScriptedProvider) -> bool:
    return any(o.kind == "lab_report" for o in await _observations(session, uid))


async def _check_lab_trend(session: AsyncSession, uid: str, p: ScriptedProvider) -> bool:
    for o in await _observations(session, uid):
        if o.kind == "lab_report" and (o.payload or {}).get("analytes"):
            return True
    return False


CHECKS: dict[str, Callable[[AsyncSession, str, ScriptedProvider], Awaitable[bool]]] = {
    "vehicle_exists": _check_vehicle,
    "note_entity_exists": _check_note,
    "kb_search_called": _check_kb_search,
    "lab_observation_exists": _check_lab_obs,
    "lab_trend_series": _check_lab_trend,
}


# --- runner ----------------------------------------------------------------


@dataclass
class CaseResult:
    name: str
    passed: bool
    detail: str = ""


class _AttrPatch:
    def __init__(self, target: Any, attr: str, value: Any):
        self.target, self.attr, self.value = target, attr, value
        self._had = hasattr(target, attr)
        self.orig = getattr(target, attr, None)

    def __enter__(self):
        setattr(self.target, self.attr, self.value)
        return self

    def __exit__(self, *exc):
        if self._had:
            setattr(self.target, self.attr, self.orig)
        else:
            try:
                delattr(self.target, self.attr)
            except AttributeError:
                pass


async def run_case(case: dict[str, Any], live: bool = False) -> CaseResult:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async with Session() as session:
        user = await bootstrap_user(session, f"{case['name']}@evals.local", "x")
        uid = user.id
        await session.commit()

    provider = ScriptedProvider(case["script"])

    async def _p(session, user_id, settings=None):
        return provider

    async def _m(session, user_id):
        return "eval-scripted"

    import app.agent.orchestrator as orch
    import app.domains.automotive.handlers as auto_h
    import app.domains.medical_labs.handlers as labs_h
    import app.llm.router as rt
    import app.rag.indexing as idx

    # Handlers import provider helpers at module top — patch every binding site.
    provider_targets = [orch, rt, idx, labs_h, auto_h]
    patches: list[_AttrPatch] = []
    if not live:
        patches = [
            *(_AttrPatch(mod, "provider_for_user", _p) for mod in provider_targets),
            *(_AttrPatch(mod, "default_model_for_user", _m) for mod in provider_targets),
        ]
    try:
        for pt in patches:
            pt.__enter__()
        async with Session() as session:
            out = await run_agent(session, uid, case["user_text"])
            await session.commit()
            if not live:
                executed = provider.executed_tools()
                expected = case["expect_tools"]
                if executed != expected:
                    return CaseResult(case["name"], False, f"tools {executed} != {expected}")
            if not out.get("assistant_text"):
                return CaseResult(case["name"], False, "empty assistant text")
            check = CHECKS.get(case["check"])
            if check is None:
                return CaseResult(case["name"], False, f"unknown check {case['check']}")
            ok = check(session, uid, provider)
            if asyncio.iscoroutine(ok):
                ok = await ok
            if not ok:
                return CaseResult(case["name"], False, f"check failed: {case['check']}")
            return CaseResult(case["name"], True)
    finally:
        for pt in reversed(patches):
            pt.__exit__(None, None, None)
        await engine.dispose()


async def run_all(live: bool | None = None) -> list[CaseResult]:
    if live is None:
        live = os.environ.get("PIA_EVAL_LIVE") == "1"
    results = []
    for case in GOLDEN:
        results.append(await run_case(case, live=live))
    return results


def main() -> int:
    results = asyncio.run(run_all())
    failed = 0
    for r in results:
        mark = "PASS" if r.passed else "FAIL"
        print(f"[{mark}] {r.name}" + (f" — {r.detail}" if r.detail else ""))
        failed += 0 if r.passed else 1
    print(f"\n{len(results) - failed}/{len(results)} golden cases passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
