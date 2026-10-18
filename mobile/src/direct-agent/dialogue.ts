import type { AgentTurn, DirectAgentOptions } from "./engine";

export const DIALOGUE_GUIDE =
  "Продолжай диалог по смыслу всей истории, включая своё последнее предложение. «Давай», «второй», «с форелью» — могут быть выбором предложенного варианта. " +
  "Если выбор неоднозначен, задай короткий уточняющий вопрос. " +
  "Найденные заметки — кандидаты, а не доказательство достаточности ответа. Ссылка или фрагмент не заменяют текст источника. " +
  "Сам выбирай следующий шаг: ответить, search_local_notes, search_web/web_search или read_web_page из доступных инструментов. " +
  "После каждого результата оцени, хватает ли данных для текущего вопроса; при необходимости меняй запрос или источник. " +
  "Для личных сведений используй память; для свежих фактов, внешних источников и недостающих сведений — разрешённый интернет-поиск. " +
  "Поисковый запрос формулируй полно, с учётом истории, а не как короткую реплику пользователя. Не отправляй личные данные из памяти поисковику без необходимости и разрешения пользователя. " +
  "После ошибки чтения ссылки попробуй поиск по теме, если он разрешён. Не повторяй без изменений неудачный вызов. " +
  "Если нужен конкретный источник, не подменяй его своим вариантом. Отличай прочитанное от предположений, приводи ссылки только на полученные источники. ";

const DENY = /не\s+(?:ищи|искать|используй|использовать).{0,25}(?:интернет|поиск)|без\s+интернета|\b(?:no web|without internet)\b/iu;
const ALLOW = /(?:ищи|поищи|найди|используй|можно|разрешаю).{0,25}(?:интернет|в сети)|\bsearch (?:the )?web\b/iu;
export function webAllowed(options: DirectAgentOptions): boolean {
  if (!options.settings.allowWeb) return false;
  let allowed = true;
  for (const turn of [...options.history, { role: "user", content: options.prompt }]) {
    if (turn.role !== "user") continue;
    if (DENY.test(turn.content)) allowed = false;
    else if (ALLOW.test(turn.content)) allowed = true;
  }
  return allowed;
}

/** Keep the end (often an offered next action) as well as the beginning. */
export function dialogueHistory(history: AgentTurn[]): AgentTurn[] {
  return history.slice(-8).map(turn => ({ ...turn, content: turn.content.length <= 6000 ? turn.content :
    turn.content.slice(0, 3000) + "\n[Середина длинного сообщения сокращена]\n" + turn.content.slice(-3000) }));
}
