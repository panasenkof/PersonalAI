from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.orchestrator import run_agent
from app.llm.providers import ChatMessage, LLMCompletionResult
from app.models import Base, Collection, Entity, Observation
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


async def _check_nothing_written(session: AsyncSession, uid: str, p: ScriptedProvider) -> bool:
    return not await _observations(session, uid) and not [
        e for e in await _entities(session, uid) if e.domain in ("notes", "automotive")
    ]


CHECKS: dict[str, Callable[[AsyncSession, str, ScriptedProvider], Awaitable[bool]]] = {
    "vehicle_exists": _check_vehicle,
    "note_entity_exists": _check_note,
    "kb_search_called": _check_kb_search,
    "lab_observation_exists": _check_lab_obs,
    "lab_trend_series": _check_lab_trend,
    "nothing_written": _check_nothing_written,
}


# --- runner ----------------------------------------------------------------


class _Trace:
    """Post-condition checks read the tools observed via emitted events (works for scripted and live runs)."""

    def __init__(self, called: list[str]) -> None:
        self._called = called

    def executed_tools(self) -> list[str]:
        return list(self._called)


@dataclass
class CaseResult:
    name: str
    passed: bool
    detail: str = ""
    tools: list[str] = field(default_factory=list)
    seconds: float = 0.0
    tokens: int = 0


@dataclass
class LiveConfig:
    base_url: str
    api_key: str
    model: str
    embedding_model: str | None

    @classmethod
    def from_env(cls) -> LiveConfig | None:
        key = os.environ.get("EVAL_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
        if not key:
            return None
        return cls(
            base_url=os.environ.get("EVAL_LLM_BASE_URL", "https://api.openai.com/v1"),
            api_key=key,
            model=os.environ.get("EVAL_LLM_MODEL", "gpt-4o-mini"),
            embedding_model=os.environ.get("EVAL_EMBEDDING_MODEL") or None,
        )


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


def _grade(case: dict[str, Any], called: list[str], answer: str, live: bool) -> str | None:
    """Trajectory + answer assertions. Returns a failure reason or None.

    Scripted runs are deterministic → the tool sequence must match exactly.
    Live runs are stochastic → every expected tool must be used (any order, extras allowed),
    forbidden tools must not be used; the outcome is judged by the DB post-condition.
    """
    expected = case["expect_tools"]
    if live:
        missing = [t for t in expected if t not in called]
        if missing:
            return f"expected tools not called: {missing} (called {called})"
    elif called != expected:
        return f"tools {called} != {expected}"
    forbidden = [t for t in case.get("forbid_tools", []) if t in called]
    if forbidden:
        return f"forbidden tools called: {forbidden}"
    if not answer.strip():
        return "empty assistant text"
    needles = case.get("answer_any")
    if needles and not any(n.lower() in answer.lower() for n in needles):
        return f"answer mentions none of {needles}: {answer[:120]!r}"
    return None


async def run_case(case: dict[str, Any], live: bool = False, live_cfg: LiveConfig | None = None) -> CaseResult:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async with Session() as session:
        user = await bootstrap_user(session, f"{case['name']}@evals.local", "x")
        uid = user.id
        # The golden harness simulates an owner who explicitly opted in.
        # Actual user collections remain deny-by-default.
        for collection in (await session.scalars(
            select(Collection).where(Collection.user_id == uid)
        )).all():
            collection.allow_cloud_llm = True
        if live:
            cfg = live_cfg or LiveConfig.from_env()
            if cfg is None:
                raise RuntimeError("live evals need EVAL_LLM_API_KEY (or OPENAI_API_KEY)")
            from app.security.crypto import encrypt_api_key
            from app.services.users import get_or_create_llm_settings

            row = await get_or_create_llm_settings(session, uid)
            row.base_url, row.default_model, row.embedding_model = cfg.base_url, cfg.model, cfg.embedding_model
            row.api_key_ciphertext, row.api_key_plain = encrypt_api_key(cfg.api_key)
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
    called: list[str] = []

    async def emit(event: dict[str, Any]) -> None:
        if event.get("type") == "tool":  # completed tool calls, in execution order (works for live LLMs too)
            called.append(str(event.get("name")))

    started = time.monotonic()
    try:
        for pt in patches:
            pt.__enter__()
        async with Session() as session:
            out = await run_agent(session, uid, case["user_text"], emit=emit)
            await session.commit()
            tokens = int(((out.get("raw_last") or {}).get("usage") or {}).get("total_tokens") or 0)
            elapsed = round(time.monotonic() - started, 2)

            def result(passed: bool, detail: str = "") -> CaseResult:
                return CaseResult(case["name"], passed, detail, list(called), elapsed, tokens)

            reason = _grade(case, called, out.get("assistant_text") or "", live)
            if reason:
                return result(False, reason)
            check = CHECKS.get(case["check"])
            if check is None:
                return result(False, f"unknown check {case['check']}")
            ok = check(session, uid, _Trace(called))  # type: ignore[arg-type]
            if asyncio.iscoroutine(ok):
                ok = await ok
            if not ok:
                return result(False, f"check failed: {case['check']}")
            return result(True)
    except Exception as exc:  # noqa: BLE001 — a crashing case is a failed case, not a crashed run
        return CaseResult(case["name"], False, f"{type(exc).__name__}: {exc}", list(called),
                          round(time.monotonic() - started, 2))
    finally:
        for pt in reversed(patches):
            pt.__exit__(None, None, None)
        await engine.dispose()


async def run_all(live: bool | None = None, runs: int = 1) -> list[CaseResult]:
    """Run every golden case `runs` times (live LLMs are stochastic: judge by pass rate)."""
    if live is None:
        live = os.environ.get("PIA_EVAL_LIVE") == "1"
    cfg = LiveConfig.from_env() if live else None
    results: list[CaseResult] = []
    for case in GOLDEN:
        for _ in range(max(1, runs)):
            results.append(await run_case(case, live=live, live_cfg=cfg))
    return results


def summarize(results: list[CaseResult], min_pass_rate: float) -> tuple[list[dict[str, Any]], bool]:
    by_case: dict[str, list[CaseResult]] = {}
    for r in results:
        by_case.setdefault(r.name, []).append(r)
    rows: list[dict[str, Any]] = []
    ok = True
    for name, rs in by_case.items():
        rate = sum(r.passed for r in rs) / len(rs)
        passed = rate >= min_pass_rate
        ok &= passed
        fails = [r.detail for r in rs if not r.passed]
        rows.append({
            "case": name, "runs": len(rs), "pass_rate": round(rate, 2), "ok": passed,
            "avg_seconds": round(sum(r.seconds for r in rs) / len(rs), 2),
            "tokens": sum(r.tokens for r in rs),
            "failures": fails[:3],
        })
    return rows, ok


def markdown_report(rows: list[dict[str, Any]], live: bool, model: str | None) -> str:
    title = f"### Agent evals — {'LIVE ' + (model or '') if live else 'scripted'}\n\n"
    lines = ["| case | runs | pass rate | avg s | tokens | |", "|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['case']} | {r['runs']} | {r['pass_rate']:.0%} | {r['avg_seconds']} | {r['tokens']} | {'✅' if r['ok'] else '❌'} |")
    fails = [f"- **{r['case']}**: {f}" for r in rows for f in r["failures"]]
    return title + "\n".join(lines) + ("\n\nFailures:\n" + "\n".join(fails) if fails else "") + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="PIA golden-set evals (scripted by default, --live for a real LLM)")
    ap.add_argument("--live", action="store_true", help="use a real LLM (EVAL_LLM_API_KEY / EVAL_LLM_BASE_URL / EVAL_LLM_MODEL)")
    ap.add_argument("--runs", type=int, default=int(os.environ.get("PIA_EVAL_RUNS", "1")), help="repetitions per case")
    ap.add_argument("--min-pass-rate", type=float, default=None,
                    help="required pass rate per case (default 1.0 scripted, 0.8 live)")
    ap.add_argument("--json", dest="json_path", help="write the machine-readable report here")
    args = ap.parse_args(argv)

    live = args.live or os.environ.get("PIA_EVAL_LIVE") == "1"
    cfg = LiveConfig.from_env() if live else None
    if live and cfg is None:
        print("SKIPPED: live evals need EVAL_LLM_API_KEY (or OPENAI_API_KEY)")
        return 0 if os.environ.get("PIA_EVAL_ALLOW_SKIP") == "1" else 2
    threshold = args.min_pass_rate if args.min_pass_rate is not None else (0.8 if live else 1.0)

    results = asyncio.run(run_all(live=live, runs=args.runs))
    rows, ok = summarize(results, threshold)
    for r in results:
        mark = "PASS" if r.passed else "FAIL"
        print(f"[{mark}] {r.name} ({r.seconds}s, tools={r.tools})" + (f" — {r.detail}" if r.detail else ""))
    total_pass = sum(r.passed for r in results)
    print(f"\n{total_pass}/{len(results)} runs passed; per-case threshold {threshold:.0%}: {'OK' if ok else 'FAILED'}")

    report = markdown_report(rows, live, cfg.model if cfg else None)
    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as f:
            json.dump({"live": live, "model": cfg.model if cfg else None, "threshold": threshold, "ok": ok,
                       "cases": rows, "runs": [asdict(r) for r in results]}, f, ensure_ascii=False, indent=2)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(report)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
