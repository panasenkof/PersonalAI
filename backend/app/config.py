from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "PIA Agent"
    database_url: str = "sqlite+aiosqlite:///./pia.db"
    jwt_secret: str = "change-me-in-production-use-long-random"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7

    # Fernet key (urlsafe base64 32-byte) for encrypting LLM API keys at rest; empty = store plaintext (dev only)
    pia_agent_secret: str = ""

    blob_storage_dir: str = "./data/blobs"
    llm_allow_local_fallback: bool = False

    telegram_bot_token: str = ""
    telegram_webhook_secret: str = ""

    default_embedding_dimensions: int = 384


@lru_cache
def get_settings() -> Settings:
    return Settings()
