import { resolveNebulaStatus, type NebulaHomeSignals } from "../homePhase";

const idle: NebulaHomeSignals = {
  voicePhase: "idle", busy: false, streamText: "", error: null, ready: true,
};

describe("neutral and factual agent status", () => {
  it("distinguishes idle, loading, voice and errors without showing the model name", () => {
    expect(resolveNebulaStatus(idle)).toBe("Готов");
    expect(resolveNebulaStatus({ ...idle, ready: false })).toBe("Загружаю");
    expect(resolveNebulaStatus({ ...idle, voicePhase: "starting" })).toBe("Включаю микрофон");
    expect(resolveNebulaStatus({ ...idle, voicePhase: "listening" })).toBe("Слушаю");
    expect(resolveNebulaStatus({ ...idle, voicePhase: "finishing" })).toBe("Распознаю речь");
    expect(resolveNebulaStatus({ ...idle, error: "Сеть недоступна" })).toBe("Нет сети");
    expect(resolveNebulaStatus({ ...idle, error: "Ошибка хранилища" })).toBe("Ошибка");
  });
  it("never manufactures a step counter and reflects real network and tool stages", () => {
    expect(resolveNebulaStatus({ ...idle, busy: true, progress: "Сохраняю вопрос…" })).toBe("Сохраняю запрос");
    expect(resolveNebulaStatus({ ...idle, busy: true, progress: "Ищу в памяти" })).toBe("Ищу в памяти");
    expect(resolveNebulaStatus({ ...idle, busy: true, progress: "Поиск в интернете" })).toBe("Ищу в интернете");
    expect(resolveNebulaStatus({ ...idle, busy: true, progress: "Запрос к LLM (1/5): модель думает" })).toBe("Думаю (1/5)");
    expect(resolveNebulaStatus({ ...idle, busy: true, progress: "Запрос к LLM (1/5): подключаюсь" })).toBe("Подключаюсь (1/5)");
    expect(resolveNebulaStatus({ ...idle, busy: true, progress: "Запрос к LLM (8/3): модель думает" })).toBe("Думаю");
    expect(resolveNebulaStatus({ ...idle, busy: true, streamText: "Начало ответа" })).toBe("Пишу ответ");
    expect(resolveNebulaStatus({ ...idle, busy: true, progress: "" })).toBe("Обрабатываю");
  });
});
