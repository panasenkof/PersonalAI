from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Protocol

from sqlalchemy.ext.asyncio import AsyncSession


ToolFn = Callable[[AsyncSession, str, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass
class DomainPlugin:
    domain_id: str
    description: str
    tool_definitions: list[dict[str, Any]]
    tool_handlers: dict[str, ToolFn]


class DomainPluginFactory(Protocol):
    def __call__(self) -> DomainPlugin: ...
