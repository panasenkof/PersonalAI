from __future__ import annotations

from typing import Any

from app.domains.base import DomainPlugin
from app.domains.medical_labs.handlers import labs_get_trends, labs_record_report


def medical_labs_plugin() -> DomainPlugin:
    tools: list[dict[str, Any]] = [
        {
            "type": "function",
            "function": {
                "name": "labs_record_report",
                "description": (
                    "Ingest a lab analysis (text pasted by the user, PDF or image in blob "
                    "storage) as a lab_report observation. Extraction only — never diagnose."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "Raw report text"},
                        "storage_key": {"type": "string"},
                        "mime": {"type": "string"},
                        "occurred_at": {"type": "string", "description": "YYYY-MM-DD"},
                    },
                    "required": [],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "labs_get_trends",
                "description": (
                    "Return the time series of one analyte (e.g. glucose, hemoglobin) "
                    "across all stored lab reports."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {"analyte": {"type": "string"}},
                    "required": ["analyte"],
                    "additionalProperties": False,
                },
            },
        },
    ]
    return DomainPlugin(
        domain_id="medical_labs",
        description="Lab reports ingestion (PDF/text/image) and analyte trends.",
        tool_definitions=tools,
        tool_handlers={
            "labs_record_report": labs_record_report,
            "labs_get_trends": labs_get_trends,
        },
    )
