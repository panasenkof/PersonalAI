"""JSON schema for LLM extraction of lab reports (text or vision path)."""

LAB_REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "panel_name": {"type": "string", "description": "e.g. Общий анализ крови"},
        "lab_name": {"type": "string"},
        "collected_at": {"type": "string", "description": "YYYY-MM-DD if present"},
        "analytes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "value": {"type": "string", "description": "numeric value as string"},
                    "unit": {"type": "string"},
                    "ref_min": {"type": "string"},
                    "ref_max": {"type": "string"},
                    "flag": {
                        "type": "string",
                        "enum": ["normal", "high", "low", "unknown"],
                    },
                },
                "required": ["name"],
            },
        },
    },
    "required": ["analytes"],
}
