"""Create a private pilot .env without overwriting an existing installation."""
import base64
import os
from pathlib import Path
import secrets


def configure(destination: Path, template: Path) -> None:
    values = {
        "JWT_SECRET": secrets.token_urlsafe(48),
        "POSTGRES_PASSWORD": secrets.token_urlsafe(32),
        "PIA_AGENT_SECRET": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
        "BACKUP_ENCRYPTION_KEY": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
        "PUBLIC_LAUNCH": "false",
        "REQUIRE_VERIFIED_EMAIL": "false",
        "RATE_LIMIT_LLM_PER_MINUTE": "30",
    }
    lines = template.read_text(encoding="utf-8").splitlines()
    content = "\n".join(
        f"{line.split('=', 1)[0]}={values[line.split('=', 1)[0]]}"
        if "=" in line and line.split("=", 1)[0] in values else line
        for line in lines
    ) + "\n"
    # O_EXCL protects existing keys and database access settings, even on races.
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
        output.write(content)


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    try:
        configure(root / ".env", root / ".env.example")
    except FileExistsError:
        raise SystemExit(".env already exists; kept unchanged. See docs/LOCAL_PILOT.md.")
    print("Created .env with private pilot keys. See docs/LOCAL_PILOT.md.")
