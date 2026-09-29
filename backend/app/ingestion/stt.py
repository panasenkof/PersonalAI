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
    """OpenAI-compatible audio transcriptions endpoint (Whisper / faster-whisper)."""

    def __init__(self, base_url: str, api_key: str | None, model: str = "whisper-1") -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    async def transcribe(self, *, storage_key: str, mime: str) -> str:
        import httpx

        from app.storage.blob import read_bytes

        data = await read_bytes(storage_key)
        ext = "ogg" if ("ogg" in mime or "opus" in mime) else ("mp3" if "mp3" in mime or "mpeg" in mime else "wav")
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{self.base_url}/audio/transcriptions",
                headers=headers,
                files={"file": (f"audio.{ext}", data, mime or f"audio/{ext}")},
                data={"model": self.model},
            )
            r.raise_for_status()
            return str(r.json().get("text") or "").strip()


def stt_provider_from_settings():
    """STT backend chosen by env: STT_BASE_URL set → Whisper, otherwise stub."""
    from app.config import get_settings

    s = get_settings()
    if s.stt_base_url:
        return WhisperApiSTTProvider(s.stt_base_url, s.stt_api_key or None, s.stt_model)
    return StubSTTProvider()
