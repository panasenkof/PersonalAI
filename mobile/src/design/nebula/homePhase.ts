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
  const ratio = progress.match(/\((\d{1,2})\s*\/\s*(\d{1,2})\)/);
  const done = ratio ? Number(ratio[1]) : 0;
  const total = ratio ? Number(ratio[2]) : 0;
  const suffix = done >= 1 && total >= done && total <= 20 ? ` (${done}/${total})` : "";
  if (/останавливаю/i.test(progress)) return "Останавливаю";
  if (/сохраняю|записываю/i.test(progress)) return "Сохраняю запрос";
  // Show stages ONLY when they were emitted by the actual agent pipeline.
  // Generic busy must not pretend that a document is being read.
  if (/готовлю итог/i.test(progress)) return "Готовлю итог" + suffix;
  if (/составляю итог|обобщаю диалог|формирую итог/i.test(progress)) return "Составляю итог" + suffix;
  if (/читаю|извлекаю|открываю/i.test(progress) && /документ|файл|источник|страниц/i.test(progress))
    return "Читаю материалы" + suffix;
  if (/обрабатываю|анализирую|сверяю/i.test(progress) && /част|фрагмент|документ|файл/i.test(progress))
    return "Обрабатываю материалы" + suffix;
  if (/проверяю/i.test(progress) && /источник|документ|ссылк/i.test(progress))
    return "Проверяю источники" + suffix;
  if (/памят|заметк|документ/i.test(progress) && /ищ|поиск|смотр|провер/i.test(progress)) return "Ищу в памяти";
  if (/интернет|веб|web|search|страниц/i.test(progress) && /ищ|поиск|запрос|загруж/i.test(progress)) return "Ищу в интернете";
  if (/подключаюсь|соединени|connecting/i.test(progress)) return "Подключаюсь" + suffix;
  if (signals.streamText?.trim() || /пишет ответ|генерирую ответ/i.test(progress)) return "Пишу ответ" + suffix;
  if (/думает|размышля|thinking|запрос к llm/i.test(progress)) return "Думаю" + suffix;
  return "Обрабатываю" + suffix;
}
