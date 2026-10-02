from __future__ import annotations

from typing import Any

from app.config import get_settings
from app.domains.automotive.plugin import automotive_plugin
from app.domains.base import DomainPlugin, ToolFn
from app.domains.medical_labs.plugin import medical_labs_plugin


def all_plugins() -> list[DomainPlugin]:
    factories = {"automotive": automotive_plugin, "medical_labs": medical_labs_plugin}
    enabled = {value.strip() for value in get_settings().enabled_domains.split(",") if value.strip()}
    unknown = enabled - factories.keys()
    if unknown:
        raise ValueError(f"Unknown enabled domains: {sorted(unknown)}")
    return [factory() for name, factory in factories.items() if name in enabled]


def tools_openai_format(plugins: list[DomainPlugin] | None = None) -> list[dict[str, Any]]:
    plugins = all_plugins() if plugins is None else plugins
    out: list[dict[str, Any]] = []
    for p in plugins:
        out.extend(p.tool_definitions)
    return out


def tool_router(plugins: list[DomainPlugin] | None = None) -> dict[str, ToolFn]:
    plugins = all_plugins() if plugins is None else plugins
    r: dict[str, ToolFn] = {}
    for p in plugins:
        r.update(p.tool_handlers)
    return r
