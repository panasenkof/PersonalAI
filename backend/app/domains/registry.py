from __future__ import annotations

from typing import Any

from app.domains.automotive.plugin import automotive_plugin
from app.domains.base import DomainPlugin, ToolFn
from app.domains.medical_labs.plugin import medical_labs_plugin


def all_plugins() -> list[DomainPlugin]:
    return [automotive_plugin(), medical_labs_plugin()]


def tools_openai_format(plugins: list[DomainPlugin] | None = None) -> list[dict[str, Any]]:
    plugins = plugins or all_plugins()
    out: list[dict[str, Any]] = []
    for p in plugins:
        out.extend(p.tool_definitions)
    return out


def tool_router(plugins: list[DomainPlugin] | None = None) -> dict[str, ToolFn]:
    plugins = plugins or all_plugins()
    r: dict[str, ToolFn] = {}
    for p in plugins:
        r.update(p.tool_handlers)
    return r
