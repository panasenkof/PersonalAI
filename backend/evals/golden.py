"""Golden scenarios for the PIA agent (scripted LLM — deterministic, offline).

Each case:
  user_text      — what the user says
  script         — ordered fake LLM replies: {"tool": name, "args": {...}} | {"final": text}
  expect_tools   — tool execution order observed in the transcript
  check          — post-condition predicate name (see runner.CHECKS)
"""

from __future__ import annotations

GOLDEN: list[dict] = [
    {
        "name": "add_vehicle",
        "user_text": "Добавь мою машину Toyota Camry 2020",
        "script": [
            {
                "tool": "auto_add_vehicle",
                "args": {"make": "Toyota", "model": "Camry", "year": 2020},
            },
            {"final": "Добавил Toyota Camry 2020 в гараж."},
        ],
        "expect_tools": ["auto_add_vehicle"],
        "answer_any": ["camry", "toyota", "тойот"],
        "check": "vehicle_exists",
    },
    {
        "name": "search_kb",
        "user_text": "Что у меня про Camry в базе?",
        "script": [
            {"tool": "kb_search", "args": {"query": "Camry"}},
            {"final": "В базе есть запись про Toyota Camry."},
        ],
        "expect_tools": ["kb_search"],
        "answer_any": ["camry"],
        "check": "kb_search_called",
    },
    {
        "name": "remember_fact",
        "user_text": "Запомни: пароль от гаража 1234",
        "script": [
            {
                "tool": "kb_create_entity",
                "args": {
                    "collection_slug": "garage",
                    "domain": "notes",
                    "payload": {"type": "note", "text": "Пароль от гаража 1234"},
                },
            },
            {"final": "Запомнил: пароль от гаража 1234."},
        ],
        "expect_tools": ["kb_create_entity"],
        "answer_any": ["1234", "запомн"],
        "check": "note_entity_exists",
    },
    {
        "name": "record_lab_report",
        "user_text": "Сохрани анализ: глюкоза 5.5 ммоль/л, гемоглобин 140 г/л",
        "script": [
            {
                "tool": "labs_record_report",
                "args": {
                    "text": "Глюкоза: 5.5 ммоль/л (реф 3.9-5.5); Гемоглобин: 140 г/л (реф 130-160)",
                    "occurred_at": "2026-09-01",
                },
            },
            {"final": "Анализ сохранён: 2 показателя."},
        ],
        "expect_tools": ["labs_record_report"],
        "answer_any": ["глюкоз", "показател", "анализ"],
        "check": "lab_observation_exists",
    },
    {
        "name": "lab_trend",
        "user_text": "Покажи динамику глюкозы",
        "script": [
            {
                "tool": "labs_record_report",
                "args": {"text": "Глюкоза: 5.1 ммоль/л", "occurred_at": "2026-08-01"},
            },
            {"tool": "labs_get_trends", "args": {"analyte": "Глюкоза"}},
            {"final": "Глюкоза: 01.08 — 5.1 ммоль/л."},
        ],
        "expect_tools": ["labs_record_report", "labs_get_trends"],
        "answer_any": ["глюкоз", "5.1", "5,1"],
        "check": "lab_trend_series",
    },
    {
        # small talk must not touch the knowledge base (guards against over-eager tool use)
        "name": "greeting_uses_no_tools",
        "user_text": "Привет! Как дела?",
        "script": [{"final": "Привет! Всё хорошо, чем могу помочь?"}],
        "expect_tools": [],
        "forbid_tools": ["kb_create_entity", "auto_add_vehicle", "labs_record_report"],
        "check": "nothing_written",
    },
]
