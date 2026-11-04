import { resolveNebulaStatus } from "../homePhase";

const running = { voicePhase: "idle" as const, ready: true, busy: true };

describe("PersAI live stage labels are grounded in real progress", () => {
  test("the dialogue summary progress is not a generic Thinking label", () => {
    expect(resolveNebulaStatus({ ...running, progress: "Готовлю итог диалога…" })).toBe("Готовлю итог");
    expect(resolveNebulaStatus({ ...running, progress: "Составляю итог (2/4)" })).toBe("Составляю итог (2/4)");
  });

  test("document stages show real source reading and bounded chunk progress", () => {
    expect(resolveNebulaStatus({ ...running, progress: "Читаю документ (1/3)" })).toBe("Читаю материалы (1/3)");
    expect(resolveNebulaStatus({ ...running, progress: "Обрабатываю части PDF (3/5)" })).toBe("Обрабатываю материалы (3/5)");
    expect(resolveNebulaStatus({ ...running, progress: "Проверяю источники" })).toBe("Проверяю источники");
    expect(resolveNebulaStatus({ ...running, progress: "Ищу документы в памяти" })).toBe("Ищу в памяти");
  });

  test("missing or invalid instrumentation never simulates stages or counts", () => {
    expect(resolveNebulaStatus({ ...running, progress: "" })).toBe("Обрабатываю");
    expect(resolveNebulaStatus({ ...running, progress: "Обрабатываю документ (12/4)" })).toBe("Обрабатываю материалы");
    expect(resolveNebulaStatus({ ...running, progress: "Составляю итог (0/3)" })).toBe("Составляю итог");
    expect(resolveNebulaStatus({ ...running, busy: false, progress: "Готовлю итог" })).toBe("Готов");
  });
});
