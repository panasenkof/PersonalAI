import asyncio
import re

from sqlalchemy import select

from app.db import SessionLocal


def account(client, email):
    token = client.post('/v1/auth/register', json={'email': email, 'password': 'secret1234'}).json()['access_token']
    return {'Authorization': f'Bearer {token}'}


def test_recovery_is_generic_and_reset_is_one_use(client, random_email, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), 'smtp_host', 'mail.test')
    monkeypatch.setattr(get_settings(), 'smtp_from', 'pia@example.com')
    monkeypatch.setattr(get_settings(), 'public_base_url', 'https://pia.example.com')
    headers = account(client, random_email)
    known = client.post('/v1/auth/password/request', json={'email': random_email})
    unknown = client.post('/v1/auth/password/request', json={'email': 'missing@example.com'})
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()
    from app.models import MailOutbox
    async def read():
        async with SessionLocal() as session:
            return await session.scalar(select(MailOutbox).where(MailOutbox.recipient == random_email))
    mail = asyncio.run(read())
    code = re.search(r'Код: (\S+)', mail.body).group(1)
    result = client.post('/v1/auth/password/reset', json={'token': code, 'new_password': 'changed1234'})
    assert result.status_code == 200
    assert client.post('/v1/auth/password/reset', json={'token': code, 'new_password': 'again1234'}).status_code == 400
    assert client.get('/v1/auth/me', headers=headers).status_code == 401
    assert client.post('/v1/auth/token', json={'email': random_email, 'password': 'changed1234'}).status_code == 200


def test_export_and_delete_include_files_but_never_secrets(client, random_email):
    import io
    import json
    import zipfile
    from pathlib import Path

    from app.models import Blob, User
    from app.storage.blob import resolve_storage_path
    headers = account(client, random_email)
    other = account(client, 'other-' + random_email)
    uploaded = client.post('/v1/blobs', headers=headers, files={'file': ('private.txt', b'PRIVATE CONTENT', 'text/plain')}).json()
    foreign = client.post('/v1/blobs', headers=other, files={'file': ('foreign.txt', b'FOREIGN CONTENT', 'text/plain')}).json()
    assert client.post('/v1/account/export', headers=headers, json={'password': 'wrong'}).status_code == 400
    response = client.post('/v1/account/export', headers=headers, json={'password': 'secret1234'})
    assert response.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    data = json.loads(archive.read('account.json'))
    assert data['account']['email'] == random_email
    assert not any('password_hash' in key or 'api_key' in key for key in data)
    assert 'FOREIGN CONTENT' not in str(data)
    files = [archive.read(name) for name in archive.namelist() if name.startswith('files/')]
    assert files == [b'PRIVATE CONTENT']
    assert client.post('/v1/account/delete', headers=headers, json={'password': 'secret1234', 'confirmation': 'wrong'}).status_code == 400
    assert client.post('/v1/account/delete', headers=headers, json={'password': 'secret1234', 'confirmation': random_email}).status_code == 200
    assert not Path(resolve_storage_path(uploaded['storage_key'])).exists()
    assert Path(resolve_storage_path(foreign['storage_key'])).exists()
    assert client.get('/v1/auth/me', headers=headers).status_code == 401
    assert client.get('/v1/auth/me', headers=other).status_code == 200
    async def absent():
        async with SessionLocal() as session:
            assert await session.scalar(select(User).where(User.email == random_email)) is None
            assert await session.scalar(select(Blob).where(Blob.storage_key == uploaded['storage_key'])) is None
    asyncio.run(absent())


def test_email_verification_is_required_and_cannot_be_replayed(client, random_email, monkeypatch):
    from app.config import get_settings
    from app.models import MailOutbox
    from app.services import mail as mail_service
    monkeypatch.setattr(mail_service, 'send_mail', lambda *args: None)
    s = get_settings()
    for key, value in {'smtp_host': 'mail.test', 'smtp_from': 'pia@example.com', 'public_base_url': 'https://pia.example.com', 'require_verified_email': True}.items():
        monkeypatch.setattr(s, key, value)
    result = client.post('/v1/auth/register', json={'email': random_email, 'password': 'secret1234'})
    assert result.status_code == 200 and result.json()['email_verification_required']
    assert client.post('/v1/auth/token', json={'email': random_email, 'password': 'secret1234'}).status_code == 403
    assert client.get('/v1/auth/me', headers={'Authorization': 'Bearer ' + result.json()['access_token']}).status_code == 401
    async def read():
        async with SessionLocal() as session:
            return await session.scalar(select(MailOutbox).where(MailOutbox.recipient == random_email))
    code = re.search(r'Код: (\S+)', asyncio.run(read()).body).group(1)
    assert client.post('/v1/auth/password/reset', json={'token': code, 'new_password': 'changed1234'}).status_code == 400
    assert client.post('/v1/auth/email/verify', json={'token': code}).status_code == 200
    assert client.post('/v1/auth/email/verify', json={'token': code}).status_code == 400
    assert client.post('/v1/auth/token', json={'email': random_email, 'password': 'secret1234'}).status_code == 200


def test_delete_rejects_active_job_and_export_bound(client, random_email, monkeypatch):
    from app.config import get_settings
    from app.models import IngestionJob, User
    headers = account(client, random_email)
    async def job():
        async with SessionLocal() as session:
            user = await session.scalar(select(User).where(User.email == random_email))
            session.add(IngestionJob(user_id=user.id, status='accepted', envelope={'text':'pending'}))
            await session.commit()
    asyncio.run(job())
    response = client.post('/v1/account/delete', headers=headers, json={'password':'secret1234','confirmation':random_email})
    assert response.status_code == 409
    assert client.get('/v1/auth/me', headers=headers).status_code == 200
    monkeypatch.setattr(get_settings(), 'account_export_max_bytes', 10)
    assert client.post('/v1/account/export', headers=headers, json={'password':'secret1234'}).status_code == 413


def test_expired_code_and_mail_retry(client, random_email, monkeypatch):
    from datetime import timedelta

    from sqlalchemy import update

    from app.config import get_settings
    from app.models import EmailAction, MailOutbox, utcnow
    from app.services import mail as service
    for key, value in {'smtp_host':'mail.test','smtp_from':'pia@example.com','public_base_url':'https://pia.example.com'}.items():
        monkeypatch.setattr(get_settings(), key, value)
    account(client, random_email)
    client.post('/v1/auth/password/request', json={'email':random_email})
    async def expire():
        async with SessionLocal() as session:
            mail = await session.scalar(select(MailOutbox).where(MailOutbox.recipient == random_email))
            code = re.search(r'Код: (\S+)', mail.body).group(1)
            await session.execute(update(EmailAction).where(EmailAction.user_id == mail.user_id).values(expires_at=utcnow()-timedelta(seconds=1)))
            await session.commit()
            return code
    code = asyncio.run(expire())
    assert client.post('/v1/auth/password/reset',json={'token':code,'new_password':'changed1234'}).status_code == 400
    def failing(*args):
        raise OSError('smtp unavailable')
    monkeypatch.setattr(service, 'send_mail', failing)
    assert asyncio.run(service.deliver_pending()) == 0
    async def retryable():
        async with SessionLocal() as session:
            mail = await session.scalar(select(MailOutbox).where(MailOutbox.recipient == random_email))
            assert mail is not None and mail.attempts == 1
    asyncio.run(retryable())


def test_failed_file_cleanup_remains_durable(client, random_email, monkeypatch):
    from app.models import BlobDeletion
    from app.services import account as service
    headers = account(client, random_email)
    uploaded = client.post('/v1/blobs', headers=headers, files={'file':('note.txt',b'private','text/plain')}).json()
    original = service.os.unlink
    def failing(path):
        if path.endswith(uploaded['storage_key'].split('/')[-1]):
            raise PermissionError('temporary volume error')
        return original(path)
    monkeypatch.setattr(service.os,'unlink',failing)
    assert client.post('/v1/account/delete',headers=headers,json={'password':'secret1234','confirmation':random_email}).status_code == 200
    async def pending():
        async with SessionLocal() as session:
            assert await session.get(BlobDeletion,uploaded['storage_key']) is not None
    asyncio.run(pending())
    monkeypatch.setattr(service.os,'unlink',original)
    assert asyncio.run(service.cleanup_deleted_blobs()) >= 1


def test_diagnostics_does_not_expose_configuration_or_content(client, random_email):
    headers=account(client,random_email)
    info=client.get('/v1/service/info').json()
    assert 'smtp_password' not in info
    response=client.get('/v1/service/diagnostics',headers=headers)
    assert response.status_code == 200 and response.headers['cache-control']=='no-store'
    assert set(response.json()) == {'version','message_mode','queue_backend','email_enabled','email_verified','totp_enabled','reminders_enabled','llm_requests_per_minute'}


def test_model_check_uses_saved_provider_and_hides_errors(client, random_email, monkeypatch):
    from app.llm import router as routing
    headers=account(client,random_email)
    class Fake:
        async def chat(self,*args,**kwargs):
            return {}
    async def provider(*args,**kwargs):
        return Fake()
    monkeypatch.setattr(routing,'provider_for_user',provider)
    response=client.post('/v1/settings/llm/test',headers=headers)
    assert response.status_code == 200 and response.json()['chat']
    class Broken:
        async def chat(self,*args,**kwargs):
            raise ValueError('secret-provider-api-key')
    async def broken(*args,**kwargs):
        return Broken()
    monkeypatch.setattr(routing,'provider_for_user',broken)
    result=client.post('/v1/settings/llm/test',headers=headers)
    assert result.status_code == 502 and 'secret-provider-api-key' not in result.text


def test_deletion_journal_reapplies_to_old_backup(client, random_email, monkeypatch, tmp_path):
    from app.config import get_settings
    from app.models import User
    from app.operations.restore_deletions import apply_journal
    headers = account(client, random_email)
    user_id = client.get('/v1/auth/me', headers=headers).json()['id']
    journal = tmp_path / 'deletions.log'
    monkeypatch.setattr(get_settings(), 'deletion_journal_path', str(journal))
    assert client.post('/v1/account/delete', headers=headers, json={'password': 'secret1234', 'confirmation': random_email}).status_code == 200
    assert journal.read_text().strip() == user_id
    async def resurrect():
        async with SessionLocal() as session:
            session.add(User(id=user_id, email=random_email, password_hash='restored-hash'))
            await session.commit()
    asyncio.run(resurrect())
    assert asyncio.run(apply_journal(journal)) == 1
    assert asyncio.run(apply_journal(journal)) == 0


def test_journal_failure_does_not_delete_account(client, random_email, monkeypatch, tmp_path):
    from app.config import get_settings
    headers = account(client, random_email)
    monkeypatch.setattr(get_settings(), 'deletion_journal_path', str(tmp_path))  # directory cannot be appended
    result = client.post('/v1/account/delete', headers=headers, json={'password':'secret1234','confirmation':random_email})
    assert result.status_code == 503
    assert client.get('/v1/auth/me', headers=headers).status_code == 200


def test_operator_model_is_ready_without_copying_key_and_blocks_expensive_override(client, random_email, monkeypatch):
    from app.config import get_settings
    from app.models import LLMSettings, User
    s = get_settings()
    monkeypatch.setattr(s, 'default_llm_api_key', 'private-operator-key')
    monkeypatch.setattr(s, 'default_llm_model', 'operator-model')
    headers = account(client, random_email)
    row = client.get('/v1/settings/llm', headers=headers).json()
    assert row['default_model'] == 'operator-model' and row['api_key_configured']
    async def no_copy():
        async with SessionLocal() as session:
            user = await session.scalar(select(User).where(User.email == random_email))
            llm = await session.get(LLMSettings, user.id)
            assert not llm.api_key_plain and not llm.api_key_ciphertext
    asyncio.run(no_copy())
    row['default_model'] = 'expensive-unapproved-model'
    assert client.patch('/v1/settings/llm', headers=headers, json=row).status_code == 422
    row['api_key'] = 'own-user-key'
    assert client.patch('/v1/settings/llm', headers=headers, json=row).status_code == 200


def test_email_reset_does_not_bypass_two_factor(client, random_email, monkeypatch):
    from app.config import get_settings
    from app.models import MailOutbox
    from app.security.totp import totp_at
    headers = account(client, random_email)
    setup = client.post('/v1/auth/2fa/setup', headers=headers).json()
    code = totp_at(setup['secret'])
    recovery = client.post('/v1/auth/2fa/enable', headers=headers, json={'code': code}).json()['recovery_codes'][0]
    for key, value in {'smtp_host':'mail.test','smtp_from':'pia@example.com','public_base_url':'https://pia.example.com'}.items():
        monkeypatch.setattr(get_settings(), key, value)
    client.post('/v1/auth/password/request', json={'email': random_email})
    async def token():
        async with SessionLocal() as session:
            mail = await session.scalar(select(MailOutbox).where(MailOutbox.recipient == random_email))
            return re.search(r'Код: (\S+)', mail.body).group(1)
    reset = {'token': asyncio.run(token()), 'new_password': 'new-secret1234'}
    assert client.post('/v1/auth/password/reset', json=reset).status_code == 400
    assert client.post('/v1/auth/password/reset', json={**reset, 'otp': recovery}).status_code == 200
    assert client.post('/v1/auth/token', json={'email': random_email, 'password': 'new-secret1234', 'otp': recovery}).status_code == 401
