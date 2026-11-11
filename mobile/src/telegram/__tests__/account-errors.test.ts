import {telegramAccountErrorMessage} from "../account-errors";
test.each([
  ["tdlib_rate_limited","Telegram временно ограничил"],
  ["tdlib_auth_code_invalid","Код Telegram неверен"],
  ["tdlib_auth_code_expired","истёк"],
  ["tdlib_auth_password_invalid","пароль"],
  ["tdlib_auth_phone_invalid","международный"],
  ["tdlib_auth_phone_blocked","ограничил использование"],
  ["tdlib_invalid_app_credentials","API ID"],
  ["tdlib_request_timeout","не ответил"],
  ["tdlib_binary_unavailable","не содержит"],
  ["tdlib_other_profile_active","другому профилю"],
])("%s is reported with a safe actionable message",(error,part)=>{
  expect(telegramAccountErrorMessage(new Error("Expo native: "+error))).toContain(part);
});
test("raw errors never disclose phone, token, code or upstream private text",()=>{
  const secret="12345678:VerySecretBotTokenValueThatMustNotLeak";
  for(const raw of [
    "tdlib_auth_code_invalid "+secret,
    "Server error, phone +12345678910, "+secret,
    "Too many attempts. Please try again later. "+secret,
  ]){
    const message=telegramAccountErrorMessage(new Error(raw));
    expect(message).not.toContain(secret);
    expect(message).not.toContain("+12345678910");
    expect(message).not.toContain(raw);
  }
});
test("unknown error has safe generic fallback",()=>{
  expect(telegramAccountErrorMessage({message:"API secret"}))
    .toContain("Операция Telegram не выполнена");
});
