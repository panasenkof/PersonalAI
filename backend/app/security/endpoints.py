"""Policy for user-selected LLM endpoints. Production trusts only operator-configured URLs."""
from urllib.parse import urlsplit, urlunsplit

from app.config import get_settings


def canonical_endpoint(value: str) -> str:
    try:
        url = urlsplit(value.strip())
        port = url.port
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError
        host = url.hostname.lower()
        if ":" in host:
            host = f"[{host}]"
        if port is not None and port != (443 if url.scheme == "https" else 80):
            host += f":{port}"
        return urlunsplit((url.scheme, host, url.path.rstrip("/"), "", ""))
    except ValueError:
        raise ValueError("invalid_llm_endpoint") from None


def validate_llm_endpoint(value: str) -> str:
    endpoint = canonical_endpoint(value)
    s = get_settings()
    if s.is_production:
        allowed = {canonical_endpoint(url) for url in s.llm_allowed_base_urls.split(",") if url.strip()}
        if endpoint not in allowed:
            raise ValueError("llm_endpoint_not_allowed")
    return endpoint
