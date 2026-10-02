from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from app.api.deps import get_current_user
from app.config import get_settings
from app.models import User
from app.services.mail import mail_configured

router = APIRouter(prefix='/v1/service', tags=['service information'])


@router.get('/info')
async def information(response: Response) -> dict:
    s = get_settings()
    response.headers['Cache-Control'] = 'no-store'
    return {'name': s.app_name, 'version': s.app_version, 'operator': s.operator_name, 'support_email': s.support_email, 'privacy_url': s.privacy_url, 'terms_url': s.terms_url, 'email_enabled': mail_configured(), 'email_verification_required': s.require_verified_email, 'backup_retention_days': s.backup_retention_days, 'reminder_channel': ('telegram' if s.telegram_bot_token else 'max' if s.max_bot_token else None) if s.reminders_enabled else None, 'max_upload_bytes': s.max_upload_bytes}


@router.get('/diagnostics')
async def diagnostics(response: Response, user: User = Depends(get_current_user)) -> dict:
    s = get_settings()
    response.headers['Cache-Control'] = 'no-store'
    # Strict allowlist: no DSN, provider keys, email, account ID or conversation content.
    return {'version': s.app_version, 'message_mode': s.message_mode, 'queue_backend': s.queue_backend, 'email_enabled': mail_configured(), 'email_verified': user.email_verified, 'totp_enabled': user.totp_enabled, 'reminders_enabled': s.reminders_enabled, 'llm_requests_per_minute': s.rate_limit_llm_per_minute}
