"""Provision an administrator from the server console, never through public registration."""
from __future__ import annotations

import argparse
import asyncio
import getpass

from pydantic import EmailStr, TypeAdapter
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal
from app.models import User, UserRole
from app.security.auth import hash_password
from app.services.users import bootstrap_user, get_user_by_email


async def grant_admin(session: AsyncSession, user_id: str) -> None:
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise ValueError("active_user_required")
    user.role = UserRole.admin.value
    await session.flush()


async def provision(email: str, password: str | None, promote_existing: bool) -> None:
    async with SessionLocal() as session:
        user = await get_user_by_email(session, email)
        if user is not None:
            if not promote_existing:
                raise SystemExit("Account exists. Verify its owner, then use --promote-existing explicitly.")
        elif promote_existing:
            raise SystemExit("Account not found.")
        else:
            if not password or not 8 <= len(password) <= 128 or len(password.encode()) > 72:
                raise SystemExit("Password must have 8–128 characters and at most 72 UTF-8 bytes.")
            user = await bootstrap_user(session, email, hash_password(password))
        await grant_admin(session, user.id)
        await session.commit()
    print(f"Administrator provisioned: {email}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("email")
    parser.add_argument("--promote-existing", action="store_true")
    args = parser.parse_args()
    email = str(TypeAdapter(EmailStr).validate_python(args.email)).lower()
    password = None
    if not args.promote_existing:
        password = getpass.getpass("New administrator password: ")
        if password != getpass.getpass("Repeat password: "):
            raise SystemExit("Passwords do not match.")
    asyncio.run(provision(email, password, args.promote_existing))


if __name__ == "__main__":
    main()
