/** Maps only known, typed native TDLib failures. Never render arbitrary
 * native/Telegram errors: those may contain phone numbers or credentials.
 */
export function telegramAccountErrorMessage(error:unknown):string{
  const raw=error instanceof Error?error.message:typeof error==="string"?error:"";
  if(raw.includes("tdlib_rate_limited")||
    /too many attempts|flood_wait/i.test(raw))
    return "Telegram временно ограничил попытки входа. Не запрашивайте новые коды; повторите позже.";
  if(raw.includes("tdlib_auth_code_invalid"))
    return "Код Telegram неверен. Проверьте актуальный код в приложении Telegram.";
  if(raw.includes("tdlib_auth_code_expired"))
    return "Срок действия кода Telegram истёк. Запросите новый код позже.";
  if(raw.includes("tdlib_auth_password_invalid"))
    return "Неверный пароль двухэтапной защиты Telegram.";
  if(raw.includes("tdlib_auth_phone_invalid"))
    return "Telegram отклонил номер. Проверьте международный формат с +.";
  if(raw.includes("tdlib_auth_phone_blocked"))
    return "Telegram ограничил использование этого номера. Проверьте аккаунт в официальном приложении.";
  if(raw.includes("tdlib_invalid_app_credentials"))
    return "Неверный API ID или API Hash. Проверьте параметры на my.telegram.org.";
  if(raw.includes("tdlib_request_timeout"))
    return "Telegram не ответил на запрос. Проверьте сеть или VPN; код повторно пока не запрашивайте.";
  if(raw.includes("telegram_app_locked")||raw.includes("tdlib_saved_profile_changed"))
    return "Разблокируйте PersAI и повторите действие.";
  if(raw.includes("tdlib_binary_unavailable")||raw.includes("telegram_tdlib_binary_missing"))
    return "Этот APK не содержит проверенную нативную TDLib.";
  if(raw.includes("tdlib_auth_state_mismatch"))
    return "Состояние входа Telegram изменилось. Проверьте текущий шаг авторизации.";
  if(raw.includes("tdlib_other_profile_active"))
    return "Сессия Telegram принадлежит другому профилю PersAI.";
  return "Операция Telegram не выполнена. Проверьте соединение и состояние авторизации.";
}
