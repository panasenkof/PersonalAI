/** Safe display of native TDLib auth failure categories. Never interpolate
 * arbitrary native Error.message: it may contain a number or secret. */
export function telegramAccountError(error:unknown):string {
  const raw=error instanceof Error?error.message:"";
  const match=/tdlib_flood_wait_([0-9]{1,6})(?![0-9])/.exec(raw);
  if(match){
    const seconds=Math.min(86400,Math.max(1,Number(match[1])));
    const minutes=Math.ceil(seconds/60);
    return "Telegram временно ограничил попытки входа. Повторите не раньше чем через "+
      (minutes<60?minutes+" мин.":Math.ceil(minutes/60)+" ч.")+
      " Не запрашивайте новые коды до окончания ограничения.";
  }
  if(/tdlib_flood_limited/.test(raw))
    return "Telegram временно ограничил попытки входа. Повторите позже, не запрашивая новые коды.";
  if(/tdlib_phone_invalid/.test(raw))
    return "Telegram не принял номер телефона. Проверьте международный формат.";
  if(/tdlib_code_invalid/.test(raw))
    return "Telegram не принял код или срок его действия истёк. Проверьте актуальный код.";
  if(/tdlib_password_invalid/.test(raw))
    return "Неверный пароль двухэтапной защиты Telegram.";
  if(/tdlib_api_invalid/.test(raw))
    return "Telegram отклонил API ID или API hash. Проверьте параметры приложения.";
  if(/tdlib_request_timeout/.test(raw))
    return "Telegram не ответил за 25 секунд. Проверьте соединение и VPN.";
  if(/tdlib_binary_unavailable/.test(raw))
    return "TDLib отсутствует в установленном APK. Требуется проверенная версия с Telegram.";
  if(/tdlib_app_locked|telegram_app_locked/.test(raw))
    return "Разблокируйте PersAI перед подключением Telegram.";
  return "Операция Telegram не выполнена. Проверьте соединение и состояние авторизации.";
}
