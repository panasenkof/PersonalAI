import { importLink } from "../link-import";
import { canRecheckTelegramText, recheckTelegramText, telegramRecheckMessage } from "../telegram-recheck";

jest.mock("../link-import", () => ({
  importLink: jest.fn(),
  publicImportUrl: jest.requireActual("../link-import").publicImportUrl,
}));
const sourceUrl = "https://t.me/public_news/42";
const initial = {
  sourceUrl, coverage: "telegram_post_text_only",
  observation: { messageKey: "public_news/42", textSha256: "a".repeat(64),
    textLength: 25, evidence: "telegram_html_data_post_v1" },
};
const latest = (hash: string, key = "public_news/42", length = 25) => ({
  source: sourceUrl, text: "Прочитанный текст", textCoverage: "telegram_post_text_only",
  telegramObservation: {messageKey:key, textSha256:hash, textLength:length,
    evidence:"telegram_html_data_post_v1"},
});
beforeEach(() => jest.clearAllMocks());

test("MSG-6: explicit read-only check compares exact post fingerprints, not body user edits", async () => {
  expect(canRecheckTelegramText(initial)).toBe(true);
  (importLink as jest.Mock).mockResolvedValue(latest("a".repeat(64)));
  const signal = new AbortController().signal;
  expect(await recheckTelegramText(initial, signal)).toBe("same_text");
  expect(importLink).toHaveBeenCalledWith(sourceUrl, signal);
  expect(telegramRecheckMessage("same_text")).toContain("не доказывает");
});

test("MSG-6: observed text change is not claimed to be a server edit or auto-merged", async () => {
  (importLink as jest.Mock).mockResolvedValue(latest("b".repeat(64)));
  expect(await recheckTelegramText(initial)).toBe("different_text");
  const message=telegramRecheckMessage("different_text");
  expect(message).toContain("не доказательство редактирования");
  expect(message).toContain("не изменена");
});

test("MSG-6: old URL-only or forged observation never triggers network", async () => {
  for(const saved of [
    {...initial,coverage:"url_only"},
    {...initial,observation:{...initial.observation,messageKey:"public_news/43"}},
    {...initial,observation:{...initial.observation,textSha256:"no"}},
    {sourceUrl:"https://t.me/public_news/42"},
    {sourceUrl:"https://example.org/post",coverage:initial.coverage,observation:initial.observation},
  ]) {
    expect(canRecheckTelegramText(saved)).toBe(false);
    expect(await recheckTelegramText(saved)).toBe("unverifiable");
  }
  expect(importLink).not.toHaveBeenCalled();
});

test("MSG-6: no exact source ID in new response => comparison unavailable", async () => {
  (importLink as jest.Mock).mockResolvedValueOnce(latest("a".repeat(64),"public_news/43"))
    .mockResolvedValueOnce({...latest("a".repeat(64)),telegramObservation:undefined});
  expect(await recheckTelegramText(initial)).toBe("unverifiable");
  expect(await recheckTelegramText(initial)).toBe("unverifiable");
});

test("MSG-6: network failure and AbortSignal propagate; nothing gets stored", async () => {
  const controller = new AbortController();controller.abort();
  (importLink as jest.Mock).mockRejectedValue(new Error("Загрузка отменена."));
  await expect(recheckTelegramText(initial,controller.signal)).rejects.toThrow("отменена");
  expect(importLink).toHaveBeenCalledWith(sourceUrl,controller.signal);
});
