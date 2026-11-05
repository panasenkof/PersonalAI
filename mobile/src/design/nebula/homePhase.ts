import type { NebulaPhase } from "./motion";

/** Mirrors actual VoiceInput phases. No simulated microphone activity. */
export type NebulaVoicePhase = "idle" | "starting" | "listening" | "finishing";

export interface NebulaHomeSignals {
  voicePhase: NebulaVoicePhase;
  busy: boolean;
  streamText?: string | null;
  error?: string | null;
  /** Before connection & history initialization there is no real model status. */
  ready: boolean;
}

export function resolveNebulaHomePhase(signals: NebulaHomeSignals): NebulaPhase {
  if (signals.voicePhase === "listening") return "listening";
  if (signals.voicePhase === "finishing") return "transcribing";
  // "starting" waits on permissions / speech service; not yet recording.
  if (signals.busy) return signals.streamText?.trim() ? "responding" : "thinking";
  if (signals.error?.trim()) {
    return /(?:no (?:internet|connection)|network (?:error|unavailable)|offline|нет (?:сети|интернета|соединения)|отсутствует соединение|сеть недоступна)/i
      .test(signals.error) ? "offline" : "error";
  }
  return "idle";
}

/** Neutral, truthful agent status vocabulary. Future character styles can
 * replace these labels without changing the underlying event signals.
 * Fractions are displayed ONLY when the engine provided valid counters. */
export function resolveNebulaStatus(signals: NebulaHomeSignals & { progress?: string | null }): string {
  if (signals.voicePhase === "starting") return "Включаю микрофон";
  if (signals.voicePhase === "listening") return "Слушаю";
  if (signals.voicePhase === "finishing") return "Распознаю речь";
  if (!signals.ready) return "Загружаю";
  if (!signals.busy) {
    const phase = resolveNebulaHomePhase(signals);
    return phase === "offline" ? "Нет сети" : phase === "error" ? "Ошибка" : "Готов";
  }
  const progress = signals.progress || "";
  // Bounded document/chunk counters ("1/3 parts") are real progress and stay.
  // Agent-loop counters ("1/5 LLM calls") are bookkeeping and stay in diagnostics.
  const chunk = progress.match(/\((\d{1,3})\s*\/\s*(\d{1,3})\)/);
  const part = chunk && Number(chunk[1]) >= 1 && Number(chunk[2]) >= Number(chunk[1]) && Number(chunk[2]) <= 200
    ? ` (${Number(chunk[1])}/${Number(chunk[2])})` : "";
  if (/останавливаю/i.test(progress)) return "Останавливаю";
  if (/сохраняю|записываю/i.test(progress)) return "Сохраняю запрос";
  // Show stages ONLY when they were emitted by the actual agent pipeline.
  // Generic busy must not pretend that a document is being read.
  if (/готовлю итог/i.test(progress)) return "Готовлю итог" + part;
  if (/составляю итог|обобщаю диалог|формирую итог/i.test(progress)) return "Составляю итог" + part;
  if (/читаю|извлекаю|открываю/i.test(progress) && /документ|файл|источник|страниц/i.test(progress))
    return "Читаю материалы" + part;
  if (/обрабатываю|анализирую|сверяю/i.test(progress) && /част|фрагмент|документ|файл/i.test(progress))
    return "Обрабатываю материалы" + part;
  if (/проверяю/i.test(progress) && /источник|документ|ссылк/i.test(progress))
    return "Проверяю источники" + part;
  if (/памят|заметк|документ/i.test(progress) && /ищ|поиск|смотр|провер/i.test(progress)) return "Ищу в памяти";
  if (/интернет|веб|web|search|страниц/i.test(progress) && /ищ|поиск|запрос|загруж/i.test(progress)) return "Ищу в интернете";
  if (/подключаюсь|соединени|connecting/i.test(progress)) return "Подключаюсь";
  if (signals.streamText?.trim() || /пишет ответ|генерирую ответ/i.test(progress)) return "Пишу ответ";
  if (/думает|размышля|thinking|запрос к llm/i.test(progress)) return "Думаю";
  return "Обрабатываю";
}


