import { analyzeFilesTogether } from "../joint-recognition";
import { fetchWithTimeout } from "../../direct-agent/net";

jest.mock("../../direct-agent/settings", () => ({
  anonymousLocalAllowed: () => false,
  validateBaseUrl: () => "https://api.example.org/v1",
  validateModel: (value: string) => value,
}));
jest.mock("../../direct-agent/net", () => ({ fetchWithTimeout: jest.fn() }));
const settings: any = { provider: "openai", model: "gpt-example", apiKey: "test-key" };
const sources = [
  { index: 0, name: "photo.png", text: "Товар куплен 12 мая" },
  { index: 1, name: "receipt.txt", text: "В чеке указано 12 мая" },
];
beforeEach(() => {
  jest.resetAllMocks();
  (fetchWithTimeout as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ output_text: "Дата совпадает [photo.png, receipt.txt]" }) });
});

test("together mode submits exactly one extra text-only model request with file provenance", async () => {
  const text = await analyzeFilesTogether(sources, settings, true);
  expect(text).toContain("Дата совпадает");
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  const [fetcher, url, params] = (fetchWithTimeout as jest.Mock).mock.calls[0];
  expect(url).toBe("https://api.example.org/v1/responses");
  const body = JSON.parse(params.body);
  expect(body.store).toBe(false);
  expect(body.input[0].content[0].text).toContain("Файл 1: photo.png");
  expect(body.input[0].content[0].text).toContain("Файл 2: receipt.txt");
  expect(JSON.stringify(body)).not.toContain("file:///");
  expect(fetcher).toBeDefined();
});

test("together mode requires explicit approval and does not leak sensitive notes", async () => {
  await expect(analyzeFilesTogether(sources, settings, false)).rejects.toThrow("разрешите");
  expect(fetchWithTimeout).not.toHaveBeenCalled();
});

test("together mode cannot silently truncate large source texts", async () => {
  await expect(analyzeFilesTogether([{ index: 0, name: "huge.txt", text: "x".repeat(41_000) }], settings, true)).rejects.toThrow("40 000");
  expect(fetchWithTimeout).not.toHaveBeenCalled();
});

test("cancelled or incomplete joint request fails instead of reporting an invented summary", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(analyzeFilesTogether(sources, settings, true, controller.signal)).rejects.toThrow("остановлен");
  (fetchWithTimeout as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ status: "incomplete" }) });
  await expect(analyzeFilesTogether(sources, settings, true)).rejects.toThrow("не завершился");
});
