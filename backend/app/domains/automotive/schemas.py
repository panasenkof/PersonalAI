"""JSON schemas for vision / extraction."""

SERVICE_RECEIPT_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "service_date": {"type": "string", "description": "ISO date if visible"},
        "odometer_km": {"type": "integer"},
        "work_items": {"type": "array", "items": {"type": "string"}},
        "vendor": {"type": "string"},
        "confidence": {"type": "string"},
    },
    "required": ["work_items"],
    "additionalProperties": True,
}

MAINTENANCE_ITEMS_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "interval_km": {"type": "integer"},
                    "interval_months": {"type": "integer"},
                },
                "required": ["name", "interval_km", "interval_months"],
                "additionalProperties": False,
            },
        },
        "source_summary": {"type": "string"},
    },
    "required": ["items", "source_summary"],
    "additionalProperties": False,
}
