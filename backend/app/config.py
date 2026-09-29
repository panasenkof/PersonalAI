from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "PIA Agent"
    # "development" | "production". Production fails closed: weak secrets abort startup and
    # channel webhooks without a configured secret are rejected.
    app_env: str = "development"
    database_url: str = "sqlite+aiosqlite:///./pia.db"
    db_null_pool: bool = False  # Postgres: no connection pooling (tests that mix event loops, pgbouncer setups)
    jwt_secret: str = "change-me-in-production-use-long-random"
    # Comma-separated previous secrets: still accepted for verification (zero-downtime rotation).
    jwt_secret_previous: str = ""
    # Comma-separated e-mails that get the admin role on registration.
    admin_emails: str = ""
    login_max_failures: int = 5  # per e-mail within login_lockout_seconds (0 = disabled)
    login_lockout_seconds: int = 900
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7
    refresh_token_expire_days: int = 30

    # Fernet key(s) (urlsafe base64 32-byte; comma-separated for rotation: first encrypts, all decrypt).
    # Used for field-level encryption at rest: LLM API keys, chat history, TOTP secrets, blob files.
    # Empty = store plaintext (dev only).
    pia_agent_secret: str = ""
    encrypt_blobs: bool = True  # encrypt uploaded files on disk when PIA_AGENT_SECRET is set

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
    # pgvector column width (Postgres only). Embeddings of another width fall back to the JSON column.
    pgvector_dimensions: int = 1536
    use_pgvector: bool = True  # auto-disabled on non-Postgres databases
    agent_history_window: int = 20
    default_embedding_model: str = "text-embedding-3-small"

    # Comma-separated CORS origins; "*" disables credentials (browser security rules)
    cors_origins: str = "*"

    # "sync" = process inside the HTTP request (dev/tests);
    # "queue" = accept immediately, process in background (production)
    message_mode: str = "sync"
    queue_concurrency: int = 4
    # "inprocess" (single instance) | "redis" (multi-replica, persistent, separate workers)
    queue_backend: str = "inprocess"
    redis_url: str = ""
    # Run the queue consumer inside the API process (set false when using dedicated `python -m app.worker`)
    embedded_worker: bool = True
    job_max_attempts: int = 3
    job_stale_seconds: int = 120  # unfinished job with no heartbeat older than this is re-queued
    job_lease_seconds: int = 60
    recover_jobs_on_start: bool = True

    # Outbound HTTP resilience (LLM, channels, STT)
    http_retry_attempts: int = 3
    http_retry_base_delay: float = 0.5
    http_retry_max_delay: float = 8.0

    # LLM cost protection: per-user messages/minute (0 = disabled), process-wide concurrent LLM calls
    rate_limit_llm_per_minute: int = 0
    llm_max_concurrency: int = 8
    agent_max_iterations: int = 10

    # Extracted facts from photos/PDF wait for user confirmation before entering the KB
    confirm_extracted_facts: bool = True

    # WhatsApp Cloud API
    whatsapp_access_token: str = ""
    whatsapp_phone_number_id: str = ""
    whatsapp_verify_token: str = ""
    whatsapp_app_secret: str = ""

    # Discord (Interactions endpoint)
    discord_public_key: str = ""
    discord_application_id: str = ""
    discord_bot_token: str = ""

    # Proactive Telegram reminders (e.g. maintenance due)
    reminders_enabled: bool = False
    reminder_check_seconds: int = 300
    reminder_km_threshold: int = 500

    # Auth rate limiting (requests per minute per client IP, 0 = disabled; prod sets 10)
    rate_limit_auth_per_minute: int = 0

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() in ("production", "prod")

    @property
    def admin_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

    @property
    def jwt_secrets(self) -> list[str]:
        """Current signing secret first, then previous ones (verification only)."""
        prev = [x.strip() for x in self.jwt_secret_previous.split(",") if x.strip()]
        return [self.jwt_secret, *prev]

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


DEFAULT_JWT_SECRET = "change-me-in-production-use-long-random"


def production_problems(s: Settings) -> list[str]:
    """Configuration errors that must abort startup when APP_ENV=production."""
    problems: list[str] = []
    if s.jwt_secret == DEFAULT_JWT_SECRET or len(s.jwt_secret) < 32:
        problems.append("JWT_SECRET must be a random string of at least 32 characters")
    if not s.pia_agent_secret.strip():
        problems.append("PIA_AGENT_SECRET (Fernet key) is required: it encrypts keys, chat history and files at rest")
    else:
        from cryptography.fernet import Fernet

        for part in s.pia_agent_secret.split(","):
            try:
                Fernet(part.strip().encode())
            except Exception:  # noqa: BLE001
                problems.append("PIA_AGENT_SECRET contains an invalid Fernet key")
                break
    if s.telegram_bot_token and not s.telegram_webhook_secret:
        problems.append("TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is set")
    if s.slack_bot_token and not s.slack_signing_secret:
        problems.append("SLACK_SIGNING_SECRET is required when SLACK_BOT_TOKEN is set")
    if s.whatsapp_access_token and not (s.whatsapp_app_secret and s.whatsapp_verify_token):
        problems.append("WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN are required when WHATSAPP_ACCESS_TOKEN is set")
    if (s.discord_application_id or s.discord_bot_token) and not s.discord_public_key:
        problems.append("DISCORD_PUBLIC_KEY is required for the Discord channel")
    if s.queue_backend == "redis" and not s.redis_url:
        problems.append("QUEUE_BACKEND=redis requires REDIS_URL")
    if s.cors_origins.strip() == "*":
        problems.append("CORS_ORIGINS must list explicit origins (not *)")
    return problems
