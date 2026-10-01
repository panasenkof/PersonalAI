export function normalizeServer(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  // Validate explicitly so server input behaves consistently on both native platforms.
  const match = /^(https?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match || (match[3] && (+match[3] < 1 || +match[3] > 65535))) {
    throw new Error("Укажите адрес сервера без /app, параметров и пароля");
  }
  const host = match[2].toLowerCase();
  const parts = host.split('.');
  const ipv4 = parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && +part <= 255);
  const local = host === 'localhost' || host === '[::1]' || (ipv4 && (+parts[0] === 127 || +parts[0] === 10 || (+parts[0] === 192 && +parts[1] === 168) || (+parts[0] === 172 && +parts[1] >= 16 && +parts[1] <= 31)));
  if (match[1].toLowerCase() === 'http' && !local) {
    throw new Error("Для удалённого сервера нужен защищённый адрес https://");
  }
  return value;
}
export function authError(detail: string): string {
  const messages: Record<string,string> = {
    email_not_verified: 'Подтвердите email по письму, затем войдите. Повторное письмо можно запросить через «Восстановить доступ».',
    email_service_unavailable: 'Почтовый сервис пока не настроен. Обратитесь к владельцу сервера.',
    invalid_or_expired_code: 'Код недействителен или истёк. Запросите новое письмо.',
    stop_active_jobs_before_deleting: 'Остановите все незавершённые задачи, прежде чем удалять аккаунт.',
    type_email_to_confirm_deletion: 'Введите email аккаунта для подтверждения удаления.',
    invalid_credentials: 'Неверный email или пароль', invalid_otp: 'Неверный код подтверждения',
    email_taken: 'Этот email уже зарегистрирован. Нажмите «Войти».',
    too_many_failed_attempts: 'Слишком много попыток. Попробуйте позже.',
    session_expired: 'Сессия истекла. Войдите снова.',
  };
  if (messages[detail]) return messages[detail];
  if (/network|fetch|offline/i.test(detail)) return 'Не удалось связаться с сервером. Проверьте интернет и адрес сервера.';
  if (/422|value_error|validation|string_too/i.test(detail)) return 'Проверьте email и пароль. Для регистрации нужно минимум 8 символов.';
  return detail;
}
