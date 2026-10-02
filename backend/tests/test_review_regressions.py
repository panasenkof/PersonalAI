from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import bcrypt
import pytest
from sqlalchemy import select, update

from app.config import get_settings
from app.db import SessionLocal
from app.ingestion.schemas import utcnow
from app.models import ChannelDelivery, IngestionJob
from app.security.auth import hash_password, password_needs_rehash, verify_password


@pytest.mark.parametrize('prefix', ['a' * 72, 'я' * 40])
def test_long_password_suffix_is_significant(prefix):
    hashed = hash_password(prefix + 'one')
    assert verify_password(prefix + 'one', hashed)
    assert not verify_password(prefix + 'two', hashed)
    assert not password_needs_rehash(hashed)


def test_legacy_password_is_upgraded_after_login(client, random_email):
    from app.services.users import bootstrap_user

    legacy = bcrypt.hashpw(b'secret1234', bcrypt.gensalt()).decode()
    async def seed():
        async with SessionLocal() as session:
            user = await bootstrap_user(session, random_email, legacy)
            await session.commit()
            return user.id
    user_id = asyncio.run(seed())
    assert client.post('/v1/auth/token', json={'email': random_email, 'password': 'secret1234'}).status_code == 200
    async def check():
        from app.models import User
        async with SessionLocal() as session:
            user = await session.get(User, user_id)
            assert not password_needs_rehash(user.password_hash)
            assert verify_password('secret1234', user.password_hash)
    asyncio.run(check())


def test_closed_registration_and_allowlist(client, random_email, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, 'registration_enabled', False)
    assert client.post('/v1/auth/register', json={'email': random_email, 'password': 'secret1234'}).status_code == 403
    monkeypatch.setattr(settings, 'registration_enabled', True)
    monkeypatch.setattr(settings, 'registration_allowed_emails', random_email.upper())
    assert client.post('/v1/auth/register', json={'email': 'excluded@example.com', 'password': 'secret1234'}).status_code == 403
    assert client.post('/v1/auth/register', json={'email': random_email, 'password': 'secret1234'}).status_code == 200


def test_message_limits_reject_before_agent_or_job(client, random_email, monkeypatch):
    token = client.post('/v1/auth/register', json={'email': random_email, 'password': 'secret1234'}).json()['access_token']
    headers = {'Authorization': f'Bearer {token}'}
    async def forbidden(*args, **kwargs):
        pytest.fail('Oversized input must never reach the model')
    monkeypatch.setattr('app.ingestion.pipeline.run_agent', forbidden)
    assert client.post('/v1/messages', headers=headers, json={'text': 'x' * 20_001}).status_code == 422
    attachments = [{'mime': 'text/plain', 'storage_key': 'x'}] * 11
    assert client.post('/v1/messages', headers=headers, json={'attachments': attachments}).status_code == 422
    async def check():
        from app.models import User
        async with SessionLocal() as session:
            user = await session.scalar(select(User).where(User.email == random_email))
            assert not await session.scalar(select(IngestionJob.id).where(IngestionJob.user_id == user.id))
    asyncio.run(check())


async def _seed_delivery():
    from app.queue.delivery import stage_reply
    from app.services.users import bootstrap_user

    async with SessionLocal() as session:
        user = await bootstrap_user(session, f'{uuid.uuid4().hex}@example.com', 'unused')
        job = IngestionJob(user_id=user.id, status='completed', envelope={'channel': 'telegram', 'channel_meta': {'chat_id': 1}}, result={'assistant_text': 'answer', 'pending_facts': [{'id': 'fact'}]})
        session.add(job)
        await session.flush()
        stage_reply(session, job)
        await session.commit()
        return job.id


@pytest.mark.asyncio
async def test_outbox_retries_saved_result_without_running_agent(monkeypatch):
    from app.queue.delivery import deliver_reply

    jid = await _seed_delivery()
    calls = []
    async def send(env, text, facts):
        calls.append((text, facts))
        if len(calls) == 1:
            raise ConnectionError('offline')
    monkeypatch.setattr('app.queue.delivery.send_reply', send)
    assert not await deliver_reply(jid)
    async with SessionLocal() as session:
        row = await session.get(ChannelDelivery, jid)
        assert row.sent_at is None and row.attempts == 1 and row.error
        job = await session.get(IngestionJob, jid)
        assert job.status == 'completed'
        await session.execute(update(ChannelDelivery).where(ChannelDelivery.job_id == jid).values(available_at=utcnow() - timedelta(seconds=1)))
        await session.commit()
    assert await deliver_reply(jid)
    assert not await deliver_reply(jid)
    assert calls == [('answer', [{'id': 'fact'}])] * 2


@pytest.mark.asyncio
async def test_outbox_recovers_expired_lease_and_has_single_sender(monkeypatch):
    from app.queue.delivery import deliver_reply

    jid = await _seed_delivery()
    async with SessionLocal() as session:
        await session.execute(update(ChannelDelivery).where(ChannelDelivery.job_id == jid).values(lease_token='dead-worker', lease_until=utcnow() - timedelta(seconds=1)))
        await session.commit()
    calls = []
    async def send(*args):
        calls.append(args)
        await asyncio.sleep(0.05)
    monkeypatch.setattr('app.queue.delivery.send_reply', send)
    assert sorted(await asyncio.gather(deliver_reply(jid), deliver_reply(jid))) == [False, True]
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_outbox_staging_rolls_back_with_job_result():
    from app.queue.delivery import stage_reply
    from app.services.users import bootstrap_user

    async with SessionLocal() as session:
        user = await bootstrap_user(session, f'{uuid.uuid4().hex}@example.com', 'unused')
        job = IngestionJob(user_id=user.id, status='accepted', envelope={'channel': 'telegram'})
        session.add(job)
        await session.commit()
        jid = job.id
        job.status = 'completed'
        job.result = {'assistant_text': 'must not escape rollback'}
        stage_reply(session, job)
        await session.flush()
        await session.rollback()
    async with SessionLocal() as session:
        assert await session.get(ChannelDelivery, jid) is None
        assert (await session.get(IngestionJob, jid)).status == 'accepted'


def test_disabled_domains_are_absent_from_mcp_and_prompt(monkeypatch):
    from app.agent.orchestrator import system_prompt
    from app.domains.registry import all_plugins, tool_router, tools_openai_format
    from app.mcp.server import _mcp_tools

    assert tools_openai_format([]) == [] and tool_router([]) == {}
    monkeypatch.setattr(get_settings(), 'enabled_domains', '')
    assert all_plugins() == []
    assert not any(tool['name'].startswith(('labs_', 'auto_')) for tool in _mcp_tools())
    assert 'labs_record_report' not in system_prompt([])
    assert 'auto_parse_service_receipt' not in system_prompt([])


@pytest.mark.asyncio
async def test_disabled_tool_cannot_be_called_via_mcp(client, random_email, monkeypatch):
    token = client.post('/v1/auth/register', json={'email': random_email, 'password': 'secret1234'}).json()['access_token']
    monkeypatch.setattr(get_settings(), 'enabled_domains', '')
    response = client.post('/mcp', headers={'Authorization': f'Bearer {token}'}, json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'labs_record_report', 'arguments': {'text': 'test'}}})
    assert response.json()['result']['isError']
    assert 'unknown_tool:labs_record_report' in str(response.json())


@pytest.mark.asyncio
async def test_long_lab_report_does_not_save_partial_values():
    from app.domains.medical_labs.handlers import labs_record_report

    async with SessionLocal() as session:
        out = await labs_record_report(session, 'unused', {'text': 'x' * 12_000 + '\ncritical analyte'})
        assert out['error'] == 'lab_report_too_long'
        assert not session.new


def test_pdf_bounds_stop_extraction_and_do_not_return_partial_text(monkeypatch):
    from app.services import documents

    calls = []
    class Page:
        def extract_text(self):
            calls.append(1)
            return 'x' * 6
    class Reader:
        pages = [Page(), Page(), Page()]
        def __init__(self, *args):
            pass
    monkeypatch.setattr('pypdf.PdfReader', Reader)
    monkeypatch.setattr(documents, 'MAX_DOC_CHARS', 10)
    with pytest.raises(documents.DocumentExtractionError, match='character_limit'):
        documents.extract_pdf_text(b'pdf')
    assert len(calls) == 2
    calls.clear()
    monkeypatch.setattr(documents, 'MAX_PDF_PAGES', 2)
    with pytest.raises(documents.DocumentExtractionError, match='page_limit'):
        documents.extract_pdf_text(b'pdf')
    assert not calls


def test_broken_and_scanned_pdf_have_explicit_outcomes():
    import io

    from pypdf import PdfWriter

    from app.services.documents import DocumentExtractionError, extract_pdf_text

    with pytest.raises(DocumentExtractionError, match='pdf_extraction_failed'):
        extract_pdf_text(b'not a PDF')
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    output = io.BytesIO()
    writer.write(output)
    assert extract_pdf_text(output.getvalue()) == ''


def test_proxy_hop_count_ignores_client_supplied_prefix(monkeypatch):
    from starlette.requests import Request

    from app.main import _client_ip

    monkeypatch.setattr(get_settings(), 'trust_proxy_headers', True)
    monkeypatch.setattr(get_settings(), 'trusted_proxy_hops', 2)
    request = Request({'type': 'http', 'client': ('10.0.0.2', 1), 'headers': [(b'x-forwarded-for', b'1.1.1.1, 203.0.113.1, 10.0.0.3')]})
    assert _client_ip(request) == '203.0.113.1'
    monkeypatch.setattr(get_settings(), 'trust_proxy_headers', False)
    assert _client_ip(request) == '10.0.0.2'


@pytest.mark.asyncio
async def test_job_completion_commits_outbox_before_delivery(monkeypatch):
    from app.queue.delivery import deliver_reply
    from app.queue.jobs import execute_job
    from app.services.users import bootstrap_user

    async with SessionLocal() as session:
        user = await bootstrap_user(session, f'{uuid.uuid4().hex}@example.com', 'unused')
        job = IngestionJob(user_id=user.id, status='accepted', envelope={'channel': 'telegram', 'text': 'hello'})
        session.add(job)
        await session.commit()
        jid = job.id
    agent_calls = []
    async def process(session, uid, job, env, emit=None):
        agent_calls.append(uid)
        job.status = 'completed'
        job.result = {'assistant_text': 'persisted result'}
        return job.result
    async def offline(*args):
        async with SessionLocal() as session:
            assert (await session.get(IngestionJob, jid)).status == 'completed'
            assert await session.get(ChannelDelivery, jid)
        raise ConnectionError('channel offline')
    monkeypatch.setattr('app.queue.jobs.process_envelope', process)
    monkeypatch.setattr('app.queue.delivery.send_reply', offline)
    await execute_job(jid)
    assert (await execute_job(jid))['skipped']
    async with SessionLocal() as session:
        await session.execute(update(ChannelDelivery).where(ChannelDelivery.job_id == jid).values(available_at=utcnow() - timedelta(seconds=1)))
        await session.commit()
    sent = []
    async def online(env, text, facts):
        sent.append(text)
    monkeypatch.setattr('app.queue.delivery.send_reply', online)
    assert await deliver_reply(jid)
    assert len(agent_calls) == 1 and sent == ['persisted result']


@pytest.mark.asyncio
async def test_approved_schedule_replaces_search_chunks(monkeypatch):
    from app.domains.automotive.handlers import auto_approve_schedule
    from app.models import Chunk, Entity, ScheduleCandidate
    from app.rag.indexing import index_entity
    from app.services.users import bootstrap_user

    async with SessionLocal() as session:
        user = await bootstrap_user(session, f'{uuid.uuid4().hex}@example.com', 'unused')
        from app.models import Collection
        collection = await session.scalar(select(Collection).where(Collection.user_id == user.id).limit(1))
        entity = Entity(user_id=user.id, collection_id=collection.id, domain='automotive', payload={'type': 'vehicle', 'approved_maintenance_schedule': {'items': [{'name': 'old_service'}]}})
        session.add(entity)
        await session.flush()
        await index_entity(session, user.id, entity)
        candidate = ScheduleCandidate(user_id=user.id, vehicle_entity_id=entity.id, source_url='https://example.com', structured={'items': [{'name': 'new_service', 'interval_km': 15000}]})
        session.add(candidate)
        await session.flush()
        assert (await auto_approve_schedule(session, user.id, {'schedule_candidate_id': candidate.id}))['status'] == 'approved'
        await session.commit()
        chunks = (await session.scalars(select(Chunk.text).where(Chunk.entity_id == entity.id))).all()
        assert 'new_service' in '\n'.join(chunks)
        assert 'old_service' not in '\n'.join(chunks)


@pytest.mark.asyncio
async def test_context_budget_prevents_paid_call(monkeypatch):
    from app.agent.orchestrator import run_agent

    async def provider(*args):
        return object()
    async def model(*args):
        return 'unused'
    async def forbidden(*args):
        pytest.fail('Context over budget must not reach provider')
    monkeypatch.setattr(get_settings(), 'agent_context_max_chars', 10)
    monkeypatch.setattr('app.agent.orchestrator.provider_for_user', provider)
    monkeypatch.setattr('app.agent.orchestrator.default_model_for_user', model)
    monkeypatch.setattr('app.agent.orchestrator._chat_step', forbidden)
    async with SessionLocal() as session:
        with pytest.raises(ValueError, match='context_budget'):
            await run_agent(session, 'unused', 'message')


@pytest.mark.asyncio
async def test_slack_api_error_with_http_200_is_not_success(monkeypatch):
    import httpx

    from app.channels import slack

    monkeypatch.setattr(get_settings(), 'slack_bot_token', 'test-token')
    async def rejected(*args, **kwargs):
        return httpx.Response(200, json={'ok': False, 'error': 'channel_not_found'})
    monkeypatch.setattr(slack, 'request_json', rejected)
    with pytest.raises(RuntimeError, match='slack_message_rejected'):
        await slack.send_slack_message('channel', 'text')


@pytest.mark.asyncio
async def test_missing_channel_configuration_keeps_reply_pending(monkeypatch):
    from app.queue.delivery import deliver_reply

    monkeypatch.setattr(get_settings(), 'telegram_bot_token', '')
    jid = await _seed_delivery()
    assert not await deliver_reply(jid)
    async with SessionLocal() as session:
        row = await session.get(ChannelDelivery, jid)
        assert row.sent_at is None and row.attempts == 1 and row.error == 'RuntimeError'


@pytest.mark.asyncio
async def test_telegram_api_rejection_with_http_200_is_not_success(monkeypatch):
    import httpx

    from app.channels import telegram

    monkeypatch.setattr(get_settings(), 'telegram_bot_token', 'test-token')
    async def rejected(*args, **kwargs):
        return httpx.Response(200, json={'ok': False, 'description': 'Rejected'})
    monkeypatch.setattr(telegram, 'request_json', rejected)
    with pytest.raises(RuntimeError, match='telegram_message_rejected'):
        await telegram.send_telegram_message(1, 'text')
