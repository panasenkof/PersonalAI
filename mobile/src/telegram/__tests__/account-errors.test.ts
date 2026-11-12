import {telegramAccountError} from "../account-errors";
test("Telegram auth flood wait displays an explicit bounded delay without secrets",()=>{
  expect(telegramAccountError(new Error("tdlib_flood_wait_125"))).toContain("3 мин.");
  expect(telegramAccountError(new Error("tdlib_flood_limited"))).toContain("ограничил");
});
test("known TDLib errors use safe actionable text",()=>{
  expect(telegramAccountError(new Error("tdlib_phone_invalid"))).toContain("номер телефона");
  expect(telegramAccountError(new Error("tdlib_code_invalid"))).toContain("код");
  expect(telegramAccountError(new Error("tdlib_password_invalid"))).toContain("пароль");
  expect(telegramAccountError(new Error("tdlib_api_invalid"))).toContain("API ID");
  expect(telegramAccountError(new Error("tdlib_request_timeout"))).toContain("25 секунд");
});
test("untrusted native error never reveals tokens, numbers or URLs",()=>{
  const secret="12345678:THISISASENSITIVE_BOT_TOKEN";
  const output=telegramAccountError(new Error("https://api.telegram.org/bot"+secret));
  expect(output).not.toContain(secret);
  expect(output).not.toContain("api.telegram.org");
});

test("cancel and expired-code errors are actionable without exposing raw payloads",()=>{
  expect(telegramAccountError(new Error("tdlib_code_expired"))).toContain("Отмените вход");
  expect(telegramAccountError(new Error("tdlib_phone_banned"))).toContain("заблокирован");
  expect(telegramAccountError(new Error("tdlib_auth_state_mismatch"))).toContain("Повторите");
});
