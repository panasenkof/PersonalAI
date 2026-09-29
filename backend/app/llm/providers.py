from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field


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


class OpenAICompatibleProvider(LLMProvider):
    def __init__(self, base_url: str, api_key: str | None) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

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
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=payload,
            )
            r.raise_for_status()
            data = r.json()
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
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=payload,
            )
            r.raise_for_status()
            data = r.json()
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
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=payload,
            )
            r.raise_for_status()
            data = r.json()
        content = data["choices"][0]["message"]["content"]
        return json.loads(content)


    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        if not texts:
            return []
        payload = {"model": model, "input": texts}
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                f"{self.base_url}/embeddings",
                headers=self._headers(),
                json=payload,
            )
            r.raise_for_status()
            data = r.json()
        items = sorted(data["data"], key=lambda d: d.get("index", 0))
        return [list(it["embedding"]) for it in items]


class CloudLLMProvider(OpenAICompatibleProvider):
    """Same as OpenAI-compatible; name clarifies intent."""

    pass


class LocalLLMProvider(OpenAICompatibleProvider):
    """Local OpenAI-compatible server (Ollama / LM Studio / vLLM)."""

    pass
