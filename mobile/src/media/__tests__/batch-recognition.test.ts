import { combinedRecognitionText, recognizeFilesSequentially } from "../batch-recognition";

const files = [
  { uri: "file:///a.png", name: "a.png", mimeType: "image/png" },
  { uri: "file:///b.mp3", name: "b.mp3", mimeType: "audio/mpeg" },
  { uri: "file:///c.txt", name: "c.txt", mimeType: "text/plain" },
];

test("recognizes media one at a time, preserves order and combines successful results in one note", async () => {
  const active: number[] = [];
  let simultaneous = 0;
  const events: number[] = [];
  const results = await recognizeFilesSequentially(files, async (_, i) => {
    simultaneous++;
    expect(simultaneous).toBe(1);
    active.push(i);
    await Promise.resolve();
    simultaneous--;
    return ["Изображение", "Аудиозапись", "Документ"][i];
  }, undefined, (_, progress) => events.push(progress));
  expect(active).toEqual([0, 1, 2]);
  expect(events).toEqual([0, 1, 1, 2, 2, 3]);
  expect(combinedRecognitionText(results, files.length)).toBe(
    "Файл 1: a.png\nИзображение\n\nФайл 2: b.mp3\nАудиозапись\n\nФайл 3: c.txt\nДокумент",
  );
});

test("a failing file does not discard other results and is not indexed as extracted fact", async () => {
  const results = await recognizeFilesSequentially(files, async (_, i) => {
    if (i === 1) throw new Error("Ошибка сети");
    return "Успешно " + i;
  });
  expect(results.map(r => r.status)).toEqual(["success", "error", "success"]);
  expect(results[1].error).toBe("Ошибка сети");
  const text = combinedRecognitionText(results, files.length);
  expect(text).toContain("Файл 3: c.txt");
  expect(text).not.toContain("Ошибка сети");
});

test("abort stops the queue; the next file is not sent to a provider", async () => {
  const abort = new AbortController();
  const calls: number[] = [];
  await expect(recognizeFilesSequentially(files, async (_, index) => {
    calls.push(index);
    if (index === 0) abort.abort();
    return "ignored";
  }, abort.signal)).rejects.toThrow("остановлено");
  expect(calls).toEqual([0]);
});

test("single file stays backward compatible and total note length is checked", () => {
  expect(combinedRecognitionText([{ index: 0, name: "x.jpg", status: "success", text: "Текст" }], 1)).toBe("Текст");
  expect(() => combinedRecognitionText([
    { index: 0, name: "a", status: "success", text: "x".repeat(40000) },
    { index: 1, name: "b", status: "success", text: "y".repeat(40000) },
  ], 2)).toThrow("60 000");
});
