"""Cross-channel privacy: MCP scopes and blob provenance are independent."""
from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.db import SessionLocal
from app.memory.privacy import remote_blob_processing_allowed
from app.models import Collection, Entity, User


def _register(client, email):
    response = client.post("/v1/auth/register", json={
        "email": email, "password": "secret1234",
    })
    assert response.status_code == 200
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def _mcp(client, headers, name="kb_list_entities", arguments=None):
    return client.post("/mcp", headers=headers, json={
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": arguments or {}},
    })


def test_mcp_never_reads_disallowed_collection_even_after_global_opt_in(client, random_email):
    headers = _register(client, random_email)
    async def seed():
        async with SessionLocal() as session:
            user = (await session.scalars(select(User).where(User.email == random_email))).one()
            collections = (await session.scalars(
                select(Collection).where(Collection.user_id == user.id)
            )).all()
            for c in collections:
                c.sensitivity = "standard"
                session.add(Entity(
                    user_id=user.id, collection_id=c.id, domain="notes",
                    payload={"private_token": f"SECRET_{c.slug.upper()}"},
                ))
            await session.commit()
    asyncio.run(seed())
    assert client.put("/v1/privacy/integrations", headers=headers, json={
        "allow_mcp_access": True,
    }).status_code == 200
    empty = _mcp(client, headers)
    assert "cloud_memory_tool_denied" in str(empty.json())
    assert client.put("/v1/privacy/collections/garage", headers=headers, json={
        "sensitivity": "standard", "allow_mcp_access": True,
    }).status_code == 200
    allowed = _mcp(client, headers).json()["result"]["content"][0]["text"]
    assert "SECRET_GARAGE" in allowed
    assert "SECRET_HEALTH" not in allowed
    # Model access and MCP access are separate switches: cloud consent alone
    # cannot widen MCP scope to include health.
    assert client.put("/v1/privacy/collections/health", headers=headers, json={
        "sensitivity": "standard", "allow_cloud_llm": True,
    }).status_code == 200
    assert "SECRET_HEALTH" not in _mcp(client, headers).json()["result"]["content"][0]["text"]
    assert client.put("/v1/privacy/collections/garage", headers=headers, json={
        "sensitivity": "standard", "allow_mcp_access": False,
    }).status_code == 200
    revoked = _mcp(client, headers)
    assert "cloud_memory_tool_denied" in str(revoked.json())
    # Unreviewed tools must never run through an enabled MCP channel.
    assert "cloud_memory_tool_denied" in str(_mcp(client, headers, "auto_fetch_maintenance_schedule").json())


def test_blob_provenance_blocks_cross_collection_cloud_export(client, random_email):
    headers = _register(client, random_email)
    file_response = client.post("/v1/blobs", headers=headers, files={
        "file": ("private.png", b"image-content", "image/png"),
    })
    assert file_response.status_code == 200
    blob = file_response.json()
    assert client.get("/v1/privacy/blobs/" + blob["blob_id"], headers=headers).json() == {
        "id": blob["blob_id"], "collection_slug": None, "sensitivity": "unclassified",
    }
    async def check(slug, embeddings=False):
        async with SessionLocal() as session:
            u = (await session.scalars(select(User).where(User.email == random_email))).one()
            return await remote_blob_processing_allowed(
                session, u.id, blob["storage_key"], slug, embeddings=embeddings,
            )
    assert asyncio.run(check("garage")) is False
    assert client.put("/v1/privacy/collections/garage", headers=headers, json={
        "sensitivity": "standard", "allow_remote_extraction": True,
        "allow_remote_embeddings": True,
    }).status_code == 200
    # Grant to a collection does not implicitly grant any uploaded blob.
    assert asyncio.run(check("garage")) is False
    classified = client.put("/v1/privacy/blobs/" + blob["blob_id"], headers=headers, json={
        "collection_slug": "health", "sensitivity": "standard",
    })
    assert classified.status_code == 200
    assert asyncio.run(check("garage")) is False  # wrong provenance
    assert asyncio.run(check("garage", embeddings=True)) is False
    assert client.put("/v1/privacy/collections/health", headers=headers, json={
        "sensitivity": "sensitive", "allow_remote_extraction": True,
    }).status_code == 200
    assert asyncio.run(check("health")) is True
    assert client.put("/v1/privacy/blobs/" + blob["blob_id"], headers=headers, json={
        "collection_slug": "health", "sensitivity": "sensitive",
    }).status_code == 200
    assert asyncio.run(check("health")) is False  # record-level sensitivity veto
    stranger = _register(client, "another-" + random_email)
    assert client.get("/v1/privacy/blobs/" + blob["blob_id"], headers=stranger).status_code == 404
    assert client.put("/v1/privacy/blobs/" + blob["blob_id"], headers=stranger, json={
        "collection_slug": "garage", "sensitivity": "standard",
    }).status_code == 404
