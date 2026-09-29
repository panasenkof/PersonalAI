from __future__ import annotations

from starlette.testclient import TestClient


def test_mcp_initialize(client: TestClient) -> None:
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert r.status_code == 200
    result = r.json()["result"]
    assert result["protocolVersion"]
    assert "tools" in result["capabilities"]
    assert result["serverInfo"]["name"] == "pia-agent"


def test_mcp_tools_list(client: TestClient) -> None:
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert r.status_code == 200
    tools = {t["name"] for t in r.json()["result"]["tools"]}
    # universal + automotive + medical
    assert {"kb_search", "kb_create_entity", "auto_add_vehicle", "labs_record_report"} <= tools
    # MCP format: inputSchema is a JSON schema
    for t in r.json()["result"]["tools"]:
        assert t["inputSchema"]["type"] == "object"


def test_mcp_tools_call_requires_auth(client: TestClient) -> None:
    r = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "kb_list_entities", "arguments": {}},
        },
    )
    assert r.status_code == 401


def test_mcp_tools_call_with_jwt(client: TestClient, random_email: str) -> None:
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    r2 = client.post(
        "/mcp",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "kb_list_entities", "arguments": {}},
        },
    )
    assert r2.status_code == 200
    payload = r2.json()["result"]
    assert payload["isError"] is False
    assert '"entities"' in payload["content"][0]["text"]

    # unknown tool → isError result (not HTTP error)
    r3 = client.post(
        "/mcp",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "does_not_exist", "arguments": {}},
        },
    )
    assert r3.json()["result"]["isError"] is True


def test_mcp_unknown_method(client: TestClient) -> None:
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 6, "method": "resources/list"})
    assert r.status_code == 200
    assert r.json()["error"]["code"] == -32601


def test_mcp_notification_returns_202(client: TestClient) -> None:
    r = client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert r.status_code == 202
