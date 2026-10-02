from __future__ import annotations

import asyncio
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.llm.admission import reserve_request
from app.llm.limits import RateLimitExceeded
from app.models import Chunk, IngestionJob, UserDailyUsage
from app.services.users import bootstrap_user


async def _user() -> str:
    async with SessionLocal() as session:
        user = await bootstrap_user(session, f'{uuid.uuid4().hex}@example.com', 'unused')
        await session.commit()
        return user.id


@pytest.mark.asyncio
async def test_old_precise_rag_match_survives_fifty_newer_partial_matches():
    from app.rag.search import _text_hits
    uid, other = await _user(), await _user()
    async with SessionLocal() as session:
        exact = Chunk(user_id=uid, text='rare exact phrase and useful details', created_at=datetime(2020, 1, 1, tzinfo=timezone.utc))
        session.add(exact)
        outsider = Chunk(user_id=other, text='rare exact phrase')
        session.add(outsider)
        for index in range(80):
            session.add(Chunk(user_id=uid, text=f'rare noise {index}'))
        await session.commit()
        hits = await _text_hits(session, uid, 'rare exact phrase', k=3)
        assert len(hits) == 3 and hits[0]['id'] == exact.id
        assert all(hit['id'] != outsider.id for hit in hits)
        assert hits[0]['score'] > hits[1]['score']


def test_deletion_journal_concurrent_append_is_complete(tmp_path):
    from app.security.journal import append_deletion
    path = tmp_path / 'journal.log'
    ids = [str(uuid.uuid4()) for _ in range(40)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda value: append_deletion(path, value), ids))
    assert sorted(path.read_text().splitlines()) == sorted(ids)


def test_backend_import_does_not_require_fcntl():
    code = """
import builtins
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name == 'fcntl':
        raise ImportError('Windows has no fcntl')
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
import app.main
print('IMPORT_OK')
"""
    result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert 'IMPORT_OK' in result.stdout


@pytest.mark.asyncio
async def test_daily_quota_persists_across_sessions_and_rolls_back_unaccepted_request(monkeypatch):
    monkeypatch.setattr(get_settings(), 'llm_requests_per_day', 1)
    uid = await _user()
    async with SessionLocal() as session:
        await reserve_request(session, uid)
        await session.rollback()
    async with SessionLocal() as session:
        await reserve_request(session, uid)
        await session.commit()
    async with SessionLocal() as session:
        with pytest.raises(RateLimitExceeded, match='daily_request_limit'):
            await reserve_request(session, uid, job=False)
        await session.rollback()
    async with SessionLocal() as session:
        row = await session.get(UserDailyUsage, (uid, datetime.now(timezone.utc).date().isoformat()))
        assert row.requests == 1


@pytest.mark.asyncio
async def test_daily_quota_resets_next_utc_day(monkeypatch):
    now = datetime(2026, 1, 5, 23, 59, tzinfo=timezone.utc)
    monkeypatch.setattr(get_settings(), 'llm_requests_per_day', 1)
    monkeypatch.setattr('app.llm.admission.utcnow', lambda: now)
    uid = await _user()
    async with SessionLocal() as session:
        await reserve_request(session, uid)
        await session.commit()
    now += timedelta(minutes=2)
    async with SessionLocal() as session:
        await reserve_request(session, uid)
        await session.commit()
        assert (await session.get(UserDailyUsage, (uid, now.date().isoformat()))).requests == 1


@pytest.mark.asyncio
async def test_admission_is_atomic_under_concurrent_jobs(monkeypatch):
    monkeypatch.setattr(get_settings(), 'max_active_jobs_per_user', 1)
    uid = await _user()
    async def submit():
        async with SessionLocal() as session:
            try:
                await reserve_request(session, uid)
            except RateLimitExceeded:
                await session.rollback()
                return False
            session.add(IngestionJob(user_id=uid, envelope={'channel': 'web'}))
            await session.commit()
            return True
    assert sorted(await asyncio.gather(submit(), submit())) == [False, True]
    async with SessionLocal() as session:
        row = await session.scalar(select(UserDailyUsage).where(UserDailyUsage.user_id == uid))
        assert row.requests == 1


def test_api_daily_and_active_limits_block_before_model(client, random_email, monkeypatch):
    token = client.post('/v1/auth/register', json={'email': random_email, 'password': 'secret1234'}).json()['access_token']
    headers = {'Authorization': f'Bearer {token}'}
    monkeypatch.setattr(get_settings(), 'llm_requests_per_day', 1)
    calls = []
    async def run(*args, **kwargs):
        calls.append(1)
        return {'assistant_text': 'ok'}
    monkeypatch.setattr('app.ingestion.pipeline.run_agent', run)
    assert client.post('/v1/messages', headers=headers, json={'text':'first'}).status_code == 200
    response = client.post('/v1/messages', headers=headers, json={'text':'second'})
    assert response.status_code == 429 and response.json()['detail'] == 'daily_request_limit'
    assert int(response.headers['Retry-After']) > 0 and len(calls) == 1
    mcp = client.post('/mcp', headers=headers, json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'kb_search','arguments':{'query':'test'}}})
    assert mcp.status_code == 429 and 'daily_request_limit' in str(mcp.json())


@pytest.mark.asyncio
async def test_all_completion_modes_have_output_budget(monkeypatch):
    from app.llm.providers import ChatMessage, OpenAICompatibleProvider
    monkeypatch.setattr(get_settings(), 'llm_max_output_tokens', 96)
    payloads = []
    def respond(request):
        import json
        payload = json.loads(request.content)
        payloads.append(payload)
        if request.url.path.endswith('/embeddings'):
            return httpx.Response(200, json={'data':[{'index':0,'embedding':[1.0]}]})
        if payload.get('stream'):
            data = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
            return httpx.Response(200, text=data, headers={'content-type':'text/event-stream'})
        return httpx.Response(200, json={'choices':[{'message':{'role':'assistant','content':'{}'}}]})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(respond), **kw))
    provider = OpenAICompatibleProvider('https://api.openai.com/v1', None)
    await provider.chat([ChatMessage(role='user', content='test')], model='test')
    await provider.stream_chat([ChatMessage(role='user', content='test')], model='test')
    await provider.text_json_schema(model='test', system='', user='', json_schema_name='test', json_schema={})
    await provider.vision_json(model='test', system='', user_text='', image_url=None, image_base64='AAAA', mime='image/png', json_schema_name='test', json_schema={})
    await provider.embed(['test'], model='test')
    assert [payload.get('max_tokens') for payload in payloads] == [96, 96, 96, 96, None]


def test_active_limit_rejects_before_job_creation_and_releases_after_cancel(client, random_email, monkeypatch):
    token = client.post('/v1/auth/register', json={'email': random_email, 'password': 'secret1234'}).json()['access_token']
    headers = {'Authorization': f'Bearer {token}'}
    uid = client.get('/v1/auth/me', headers=headers).json()['id']
    monkeypatch.setattr(get_settings(), 'max_active_jobs_per_user', 1)
    async def seed():
        async with SessionLocal() as session:
            job = IngestionJob(user_id=uid, envelope={'channel':'web'}, status='accepted')
            session.add(job)
            await session.commit()
            return job.id
    job_id = asyncio.run(seed())
    calls = []
    async def run(*args, **kwargs):
        calls.append(1)
        return {'assistant_text':'ok'}
    monkeypatch.setattr('app.ingestion.pipeline.run_agent', run)
    response = client.post('/v1/messages', headers=headers, json={'text':'blocked'})
    assert response.status_code == 429 and response.json()['detail'] == 'active_jobs_limit'
    assert not calls
    async def cancel():
        async with SessionLocal() as session:
            job = await session.get(IngestionJob, job_id)
            job.status = 'cancelled'
            await session.commit()
    asyncio.run(cancel())
    assert client.post('/v1/messages', headers=headers, json={'text':'admitted'}).status_code == 200
    assert len(calls) == 1
