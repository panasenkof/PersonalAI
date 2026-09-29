from __future__ import annotations

import inspect
import json
from abc import ABC, abstractmethod
from typing import Any, Awaitable, Callable, Literal

import httpx
from pydantic import BaseModel, Field

from app.llm.limits import llm_slot
from app.net.retry import with_retry

# on_tool_delta(index, tool_name, arguments_fragment): live tool-call construction
ToolDeltaFn = Callable[[int, str, str], Awaitable[None] | None]


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    tool_call_id: str | None = None
    name: str | None = None
    tool_calls: list[dict[str, Any]] | None = None


class LLMCompletionResult(BaseModel):
    message: ChatMessage
    raw: dict[str, Any] = Field(default_factory=dict)


class LLMProvider(ABC):
    """OpenAI-compatible chat completions abstraction."""

    @abstractmethod
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = "auto",
        temperature: float = 0.2,
    ) -> LLMCompletionResult:
        raise NotImplementedError

    @abstractmethod
    async def vision_json(
        self,
        *,
        model: str,
        system: str,
        user_text: str,
        image_url: str | None,
        image_base64: str | None,
        mime: str,
        json_schema_name: str,
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    async def text_json_schema(
        self,
        *,
        model: str,
        system: str,
        user: str,
        json_schema_name: str,
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        """Embed texts via the provider's /embeddings endpoint."""
        raise NotImplementedError

    async def stream_chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = "auto",
        temperature: float = 0.2,
        on_token: Callable[[str], Awaitable[None] | None] | None = None,
        on_tool_delta: ToolDeltaFn | None = None,
    ) -> LLMCompletionResult:
        """Streaming chat; raises NotImplementedError when unsupported."""
        raise NotImplementedError


class OpenAICompatibleProvider(LLMProvider):
    def __init__(self, base_url: str, api_key: str | None) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    async def _post_json(self, path: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        """POST with bounded concurrency and retry/backoff on transient failures."""

        async def _once() -> dict[str, Any]:
            async with llm_slot():
                async with httpx.AsyncClient(timeout=timeout) as client:
                    r = await client.post(f"{self.base_url}{path}", headers=self._headers(), json=payload)
                    r.raise_for_status()
                    return r.json()

        return await with_retry(_once, label=f"llm{path}")

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = "auto",
        temperature: float = 0.2,
    ) -> LLMCompletionResult:
        payload: dict[str, Any] = {
            "model": model,
            "messages": [m.model_dump(exclude_none=True) for m in messages],
            "temperature": temperature,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice or "auto"
        data = await self._post_json("/chat/completions", payload, 120.0)
        choice = data["choices"][0]["message"]
        msg = ChatMessage(
            role=choice.get("role", "assistant"),
            content=choice.get("content"),
            tool_calls=choice.get("tool_calls"),
        )
        return LLMCompletionResult(message=msg, raw=data)

    async def vision_json(
        self,
        *,
        model: str,
        system: str,
        user_text: str,
        image_url: str | None,
        image_base64: str | None,
        mime: str,
        json_schema_name: str,
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        parts: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
        if image_url:
            parts.append({"type": "image_url", "image_url": {"url": image_url}})
        elif image_base64:
            parts.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{image_base64}"},
                }
            )
        payload: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": parts},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": json_schema_name, "schema": json_schema, "strict": False},
            },
            "temperature": 0.1,
        }
        data = await self._post_json("/chat/completions", payload, 180.0)
        content = data["choices"][0]["message"]["content"]
        return json.loads(content)

    async def text_json_schema(
        self,
        *,
        model: str,
        system: str,
        user: str,
        json_schema_name: str,
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": json_schema_name, "schema": json_schema, "strict": False},
            },
            "temperature": 0.1,
        }
        data = await self._post_json("/chat/completions", payload, 120.0)
        content = data["choices"][0]["message"]["content"]
        return json.loads(content)

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        if not texts:
            return []
        payload = {"model": model, "input": texts}
        data = await self._post_json("/embeddings", payload, 60.0)
        items = sorted(data["data"], key=lambda d: d.get("index", 0))
        return [list(it["embedding"]) for it in items]


    async def stream_chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = "auto",
        temperature: float = 0.2,
        on_token: Callable[[str], Awaitable[None] | None] | None = None,
        on_tool_delta: ToolDeltaFn | None = None,
    ) -> LLMCompletionResult:
        """SSE streaming with delta accumulation (content + tool calls).

        Connection-level failures (before the first byte is consumed) are retried with
        backoff; once output has been delivered to the consumer the error is propagated
        so the caller can reset the UI and fall back.
        """
        payload: dict[str, Any] = {
            "model": model,
            "messages": [m.model_dump(exclude_none=True) for m in messages],
            "temperature": temperature,
            "stream": True,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice or "auto"

        async def _emit(fn: Callable[..., Awaitable[None] | None] | None, *args: Any) -> None:
            if fn is None:
                return
            res = fn(*args)
            if inspect.isawaitable(res):
                await res

        class _Started(Exception):
            """Raised internally to mark that output already reached the consumer."""

        async def _attempt() -> tuple[list[str], dict[int, dict[str, Any]], dict[str, Any]]:
            content_parts: list[str] = []
            tool_acc: dict[int, dict[str, Any]] = {}
            usage: dict[str, Any] = {}
            delivered = False
            async with llm_slot():
                try:
                    async with httpx.AsyncClient(timeout=180.0) as client:
                        async with client.stream(
                            "POST",
                            f"{self.base_url}/chat/completions",
                            headers=self._headers(),
                            json=payload,
                        ) as resp:
                            resp.raise_for_status()
                            async for line in resp.aiter_lines():
                                if not line.startswith("data:"):
                                    continue
                                data = line[5:].strip()
                                if data == "[DONE]":
                                    break
                                try:
                                    chunk = json.loads(data)
                                except json.JSONDecodeError:
                                    continue
                                if chunk.get("usage"):
                                    usage = chunk["usage"]
                                for choice in chunk.get("choices") or []:
                                    delta = choice.get("delta") or {}
                                    piece = delta.get("content")
                                    if piece:
                                        content_parts.append(piece)
                                        delivered = True
                                        await _emit(on_token, piece)
                                    for tc in delta.get("tool_calls") or []:
                                        idx = int(tc.get("index") or 0)
                                        acc = tool_acc.setdefault(
                                            idx,
                                            {
                                                "id": "",
                                                "type": "function",
                                                "function": {"name": "", "arguments": ""},
                                            },
                                        )
                                        if tc.get("id"):
                                            acc["id"] = tc["id"]
                                        fn = tc.get("function") or {}
                                        if fn.get("name"):
                                            acc["function"]["name"] = fn["name"]
                                        frag = fn.get("arguments") or ""
                                        if frag:
                                            acc["function"]["arguments"] += frag
                                        if fn.get("name") or frag:
                                            delivered = True
                                            await _emit(on_tool_delta, idx, acc["function"]["name"], frag)
                except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                    if delivered:
                        raise _Started() from exc
                    raise
            return content_parts, tool_acc, usage

        try:
            content_parts, tool_acc, usage = await with_retry(_attempt, label="llm/stream")
        except _Started as started:
            cause = started.__cause__
            raise cause if cause is not None else started  # let the caller decide (reset + fallback)

        tool_calls = [tool_acc[i] for i in sorted(tool_acc)] or None
        msg = ChatMessage(
            role="assistant",
            content="".join(content_parts) or None,
            tool_calls=tool_calls,
        )
        return LLMCompletionResult(message=msg, raw={"usage": usage, "streamed": True})


class CloudLLMProvider(OpenAICompatibleProvider):
    """Same as OpenAI-compatible; name clarifies intent."""

    pass


class LocalLLMProvider(OpenAICompatibleProvider):
    """Local OpenAI-compatible server (Ollama / LM Studio / vLLM)."""

    pass
