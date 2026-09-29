from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "PIA Agent"
    database_url: str = "sqlite+aiosqlite:///./pia.db"
    jwt_secret: str = "change-me-in-production-use-long-random"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7
    refresh_token_expire_days: int = 30

    # Fernet key (urlsafe base64 32-byte) for encrypting LLM API keys at rest; empty = store plaintext (dev only)
    pia_agent_secret: str = ""

    blob_storage_dir: str = "./data/blobs"
    max_upload_bytes: int = 20 * 1024 * 1024  # 20 MB
    llm_allow_local_fallback: bool = False
    # Cloud fallback target when local LLM fails (used only when llm_allow_local_fallback=true)
    fallback_base_url: str = ""
    fallback_api_key: str = ""
    fallback_model: str = "gpt-4o-mini"

    telegram_bot_token: str = ""
    telegram_webhook_secret: str = ""

    # Slack (Events API) channel
    slack_bot_token: str = ""
    slack_signing_secret: str = ""

    # Speech-to-text (OpenAI-compatible /audio/transcriptions; empty = stub)
    stt_base_url: str = ""
    stt_api_key: str = ""
    stt_model: str = "whisper-1"

    # Observability: "text" or "json" logs
    log_format: str = "text"
    log_level: str = "INFO"

    default_embedding_dimensions: int = 384
    agent_history_window: int = 20
    default_embedding_model: str = "text-embedding-3-small"

    # Comma-separated CORS origins; "*" disables credentials (browser security rules)
    cors_origins: str = "*"

    # "sync" = process inside the HTTP request (dev/tests);
    # "queue" = accept immediately, process in background (production)
    message_mode: str = "sync"
    queue_concurrency: int = 4

    # Proactive Telegram reminders (e.g. maintenance due)
    reminders_enabled: bool = False
    reminder_check_seconds: int = 300
    reminder_km_threshold: int = 500

    # Auth rate limiting (requests per minute per client IP, 0 = disabled; prod sets 10)
    rate_limit_auth_per_minute: int = 0

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
