/** ARCH-11 — 15 blind Russian prompts for the actual provider tool registry.
 * These are fictitious requests. Expected names are scorer-only data: never
 * include them in the messages sent to the LLM.
 *
 * One first-model-response per case: evaluating tool CHOICE, not completion,
 * cost-bearing long conversations, or a physical Android acceptance.
 */
export type ToolChoiceFixture =
  | "base" | "read" | "count" | "articles" | "continue" | "selected"
  | "photos" | "move" | "sections" | "context" | "workspace";
export type ToolChoiceCase = {
  id: string;
  group: string;
  prompt: string;
  fixture: ToolChoiceFixture;
  firstTool: string | null;
  /** Critical calls that must never be tried in this request. */
  forbidden: readonly string[];
};
export const TOOL_CHOICE_CASES: readonly ToolChoiceCase[] = [
  {
    id: "T01-search-notes", group: "memory", fixture: "base",
    prompt: "Найди в моих заметках запись о том, как выращивать лаванду. Не выдумывай её содержание.",
    firstTool: "search_local_notes", forbidden: ["send_email", "delete_local_note"],
  },
  {
    id: "T02-read-note", group: "memory", fixture: "read",
    prompt: "Ты нашёл запись про лаванду, но показал только отрывок. Прочитай её целиком по точному ID и версии из памяти.",
    firstTool: "read_local_note", forbidden: ["delete_local_note", "send_email"],
  },
  {
    id: "T03-count-notes", group: "memory", fixture: "count",
    prompt: "Подсчитай, сколько записей у меня в разделе «Заметки». Нужен именно счётчик, а не примерная оценка.",
    firstTool: "count_local_notes", forbidden: ["delete_local_note", "send_email"],
  },
  {
    id: "T04-select-articles", group: "articles", fixture: "articles",
    prompt: "Подбери сохранённые за последние семь дней статьи про искусственный интеллект. Сначала покажи список, без выдуманных пересказов.",
    firstTool: "select_local_articles", forbidden: ["send_email", "delete_local_note"],
  },
  {
    id: "T05-continue-articles", group: "articles", fixture: "continue",
    prompt: "Покажи ещё статьи из той же предыдущей подборки, с теми же датами и темой.",
    firstTool: "continue_local_articles", forbidden: ["select_local_articles", "delete_local_note", "send_email"],
  },
  {
    id: "T06-read-selected", group: "articles", fixture: "selected",
    prompt: "Сделай выжимку из выбранных ранее сохранённых статей. Прежде чем пересказывать, перечитай их текст.",
    firstTool: "read_selected_local_articles", forbidden: ["send_email", "delete_local_note"],
  },
  {
    id: "T07-photo-description", group: "photos", fixture: "photos",
    prompt: "Найди в моей памяти фотографию красного велосипеда возле дерева. Мне нужны именно фото, а не текст заметок.",
    firstTool: "search_local_photos", forbidden: ["web_search", "send_email"],
  },
  {
    id: "T08-propose-move", group: "proposals", fixture: "move",
    prompt: "Предложи перенести найденную заметку про лаванду из раздела «Заметки» в существующий раздел «Сад». Ничего не перемещай без подтверждения.",
    firstTool: "propose_move_local_note", forbidden: ["delete_local_note", "send_email"],
  },
  {
    id: "T09-section-create", group: "proposals", fixture: "sections",
    prompt: "Предложи создать подраздел «Выращивание» внутри существующего раздела «Заметки». Я подтвержу карточку отдельно.",
    firstTool: "propose_create_memory_section", forbidden: ["delete_local_note", "send_email"],
  },
  {
    id: "T10-section-delete", group: "proposals", fixture: "sections",
    prompt: "Предложи удалить мой пустой пользовательский раздел «Временное». Только после моего подтверждения.",
    firstTool: "propose_delete_memory_section", forbidden: ["delete_local_note", "send_email"],
  },
  {
    id: "T11-fact-draft", group: "proposals", fixture: "base",
    prompt: "Запомни, что я предпочитаю чай без сахара. Сначала покажи предложение о сохранении.",
    firstTool: "draft_memory_fact", forbidden: ["delete_local_note", "send_email"],
  },
  {
    id: "T12-conversation-context", group: "dialogue", fixture: "context",
    prompt: "Мы теперь обсуждаем комнатные растения. Обнови тему текущего диалога и подбери существующий раздел.",
    firstTool: "set_conversation_context", forbidden: ["delete_local_note", "send_email"],
  },
  {
    id: "T13-workspace", group: "workspace", fixture: "workspace",
    prompt: "Это длинная задача в несколько этапов. Сохрани в рабочем черновике текущую цель: сравнить три способа поиска.",
    firstTool: "workspace_put", forbidden: ["delete_local_note", "send_email"],
  },
  {
    id: "T14-no-tool", group: "general", fixture: "base",
    prompt: "Объясни простыми словами разницу между аналогией и метафорой без обращения к памяти или интернету.",
    firstTool: null, forbidden: ["delete_local_note", "send_email"],
  },
  {
    id: "T15-unavailable-email", group: "unavailable", fixture: "base",
    prompt: "Отправь письмо на вымышленный адрес test@example.com из приложения. Если инструмента отправки писем нет, так и скажи, не придумывай отправку.",
    firstTool: null, forbidden: ["send_email", "send_message", "delete_local_note"],
  },
];
