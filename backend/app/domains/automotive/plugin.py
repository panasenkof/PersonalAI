from __future__ import annotations

from typing import Any

from app.domains.automotive.handlers import (
    auto_add_service_event,
    auto_add_vehicle,
    auto_approve_schedule,
    auto_compute_next_due,
    auto_fetch_maintenance_schedule,
    auto_parse_service_receipt,
)
from app.domains.base import DomainPlugin


def automotive_plugin() -> DomainPlugin:
    tools: list[dict[str, Any]] = [
        {
            "type": "function",
            "function": {
                "name": "auto_add_vehicle",
                "description": "Add a vehicle to the garage collection as an automotive entity.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "make": {"type": "string"},
                        "model": {"type": "string"},
                        "year": {"type": "integer"},
                        "vin": {"type": "string"},
                        "odometer_km": {"type": "integer"},
                        "collection_slug": {"type": "string"},
                    },
                    "required": ["make", "model", "year"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "auto_add_service_event",
                "description": "Record a maintenance visit for a vehicle entity.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "vehicle_entity_id": {"type": "string"},
                        "occurred_at": {"type": "string"},
                        "odometer_km": {"type": "integer"},
                        "work_items": {"type": "array", "items": {"type": "string"}},
                        "notes": {"type": "string"},
                    },
                    "required": ["vehicle_entity_id", "occurred_at"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "auto_parse_service_receipt",
                "description": "Parse a receipt image already stored in blob storage and attach as service_event.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "storage_key": {"type": "string"},
                        "mime": {"type": "string"},
                        "vehicle_entity_id": {"type": "string"},
                    },
                    "required": ["storage_key", "vehicle_entity_id"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "auto_fetch_maintenance_schedule",
                "description": "Fetch a draft maintenance schedule from the web (DuckDuckGo summary) and LLM structuring.",
                "parameters": {
                    "type": "object",
                    "properties": {"vehicle_entity_id": {"type": "string"}},
                    "required": ["vehicle_entity_id"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "auto_approve_schedule",
                "description": "Approve a schedule candidate and attach to vehicle payload for deterministic due calculations.",
                "parameters": {
                    "type": "object",
                    "properties": {"schedule_candidate_id": {"type": "string"}},
                    "required": ["schedule_candidate_id"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "auto_compute_next_due",
                "description": "Compute next odometer targets from approved schedule and last service observations.",
                "parameters": {
                    "type": "object",
                    "properties": {"vehicle_entity_id": {"type": "string"}},
                    "required": ["vehicle_entity_id"],
                    "additionalProperties": False,
                },
            },
        },
    ]
    handlers = {
        "auto_add_vehicle": auto_add_vehicle,
        "auto_add_service_event": auto_add_service_event,
        "auto_parse_service_receipt": auto_parse_service_receipt,
        "auto_fetch_maintenance_schedule": auto_fetch_maintenance_schedule,
        "auto_approve_schedule": auto_approve_schedule,
        "auto_compute_next_due": auto_compute_next_due,
    }
    return DomainPlugin(
        domain_id="automotive",
        description="Vehicles, service history, schedules.",
        tool_definitions=tools,
        tool_handlers=handlers,
    )
