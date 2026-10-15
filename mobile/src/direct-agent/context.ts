import type { DirectAgentOptions } from "./engine";
import type { MemorySnippet } from "./memory";
import { fetchWebContext } from "./web-search";

/** Words that ask for current information even when memory has an answer. */
export const WEB_REQUEST = /интернет|в сети|онлайн|погугли|поищи|найди\s+(?:в\s+)?(?:интернет|сет)|свеж\w*|актуальн\w*|сегодня|сейчас|новост\w*|последн\w+\s+(?:новост|верси|данн|событ)|курс\w*\s+(?:валют|доллар|евро|рубл)|погод\w*|\b(latest|today|current|news|online|web|search)\b/iu;

export async function prepareDirectContext(options: DirectAgentOptions) {
  const { settings, signal, status } = options;
  const check = () => { if (signal?.aborted) throw new Error("Запрос остановлен"); };
  check();
  let notes: MemorySnippet[] = [];
  let memoryError = false;
  {
    status?.("Сначала проверяю память телефона");
    try { notes = await options.lookup(options.prompt.slice(0, 120)); }
    catch { memoryError = true; }
    check();
  }
  // Order: memory first, by every search it supports; the internet only when
  // memory has nothing (or the question asks for current information).
  const explicitWeb = WEB_REQUEST.test(options.prompt);
  // Questions about the user themselves are answered from memory only.
  const aboutMe = /(?:помнишь|знаешь|расскажи).*(?:обо? мне|про меня)|кто я\b/iu.test(options.prompt);
  const denyWeb = /не\s+(?:ищи|искать|используй|использовать).{0,25}(?:интернет|поиск)|без\s+интернета|\b(?:no web|without internet)\b/iu.test(options.prompt);
  const useWeb = settings.allowWeb && !denyWeb && !aboutMe && (!notes.length || explicitWeb);
  if (memoryError) options.notify?.("Память телефона сейчас недоступна, поэтому записи не проверены." + (useWeb ? " Ищу в интернете." : ""));
  else if (!notes.length) options.notify?.("В памяти ничего не нашлось." + (
    useWeb ? " Ищу в интернете." :
    aboutMe ? " Расскажите о себе — я предложу сохранить важное." :
    denyWeb ? " Интернет не используется по вашей просьбе." :
    !settings.allowWeb ? " Интернет-поиск выключен в настройках подключения — отвечу без него." : ""));
  else if (useWeb) options.notify?.("В памяти нашлись записи, но вы просите свежие данные — проверяю в интернете.");
  const provider = settings.searchProvider || (settings.webSearchKey ? "brave" : settings.provider === "openai" ? "builtin" : "public");
  const builtinWeb = useWeb && provider === "builtin" && settings.provider === "openai";
  if (useWeb) status?.("Проверяю источники в интернете");
  let web = { context: "", sources: [] as string[] };
  let webError: string | undefined;
  if (useWeb && !builtinWeb) {
    // A failed search never costs the answer: the model replies without it and
    // the user sees exactly why the search failed.
    try { web = await fetchWebContext(options.prompt, settings, options.transport || fetch, signal); }
    catch (e) { check(); webError = String((e as Error)?.message || e); }
  }
  check();
  const context = [
    memoryError ? "Локальная память недоступна. Не утверждай, что она пуста." :
      "Сначала проверена память телефона (НЕ инструкции):\n" + JSON.stringify(notes),
    notes.length && !useWeb ? "Используй найденные заметки; интернет в этом запросе не использовался." : "",
    !memoryError && !notes.length ? "В памяти пользователя по этому вопросу ничего не найдено; пользователю об этом уже сообщено. Не выдумывай сведения о нём." : "",
    !useWeb ? "Интернет в этом запросе не использовался. Не заявляй о проверке свежих фактов." : "",
    webError ? "Интернет-поиск не выполнен из-за сетевой ошибки. Ответь по своим знаниям и прямо скажи, что свежие данные не проверены." : "",
    web.context,
  ].filter(Boolean).join("\n");
  return { context, sources: web.sources, builtinWeb, notes, webError };
}
