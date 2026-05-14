from app.agent.universal_tools import parse_tool_arguments


def test_parse_tool_arguments_empty() -> None:
    assert parse_tool_arguments(None) == {}
    assert parse_tool_arguments("") == {}


def test_parse_tool_arguments_json() -> None:
    assert parse_tool_arguments('{"a":1}') == {"a": 1}
