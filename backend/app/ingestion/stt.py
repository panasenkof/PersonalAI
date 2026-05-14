"""Speech-to-text adapter: pluggable; default stub returns empty and relies on text."""

from __future__ import annotations

from abc import ABC, abstractmethod


class STTProvider(ABC):
    @abstractmethod
    async def transcribe(self, *, storage_key: str, mime: str) -> str:
        raise NotImplementedError


class StubSTTProvider(STTProvider):
    async def transcribe(self, *, storage_key: str, mime: str) -> str:
        return ""


class WhisperApiSTTProvider(STTProvider):
    """Optional: OpenAI-compatible audio transcriptions endpoint."""

    def __init__(self, base_url: str, api_key: str | None, model: str = "whisper-1") -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    async def transcribe(self, *, storage_key: str, mime: str) -> str:
        # MVP: would read file from blob store and POST multipart; stub path used in tests
        _ = (storage_key, mime)
        return ""
