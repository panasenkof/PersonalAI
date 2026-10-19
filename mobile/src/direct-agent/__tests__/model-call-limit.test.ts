import { runDirectAgent } from "../engine";
import type { DirectProvider } from "../settings";
import { defaultDirectPreferences } from "../settings";

const protocols: DirectProvider[] = ["openai", "openai-compatible", "anthropic"];
function response(provider: DirectProvider, done = false) {
  const data = provider === "openai" ? { status: "completed", output: done
    ? [{ type: "message", content: [{ type: "output_text", text: "Готово" }] }]
    : [{ type: "function_call", name: "search_local_notes", call_id: "call", arguments: '{"query":"заметки"}' }] }
    : provider === "anthropic" ? { content: done ? [{ type: "text", text: "Готово" }]
      : [{ type: "tool_use", id: "call", name: "search_local_notes", input: { query: "заметки" } }] }
    : { choices: [{ message: done ? { role: "assistant", content: "Готово" }
      : { role: "assistant", content: null, tool_calls: [{ id: "call", function: { name: "search_local_notes", arguments: '{"query":"заметки"}' } }] } }] };
  return { ok: true, status: 200, json: async () => data };
}
function run(provider: DirectProvider, maxRequests: number, transport: jest.Mock, status = jest.fn()) {
  return runDirectAgent({ settings: { ...defaultDirectPreferences, provider, apiKey: "test-key", webSearchKey: "" },
    prompt: "Что в моих заметках?", history: [], lookup: async () => [], propose: () => {},
    maxRequests, transport: transport as any, status });
}

test.each(protocols)("%s stops at the chosen limit and displays that limit in progress", async provider => {
  const transport = jest.fn(async () => response(provider)); const status = jest.fn();
  await expect(run(provider, 2, transport, status)).rejects.toThrow("лимит обращений к LLM за один вопрос: 2");
  expect(transport).toHaveBeenCalledTimes(2);
  expect(status).toHaveBeenCalledWith("Запрос к LLM (2/2)");
});
test.each(protocols)("%s can finish beyond the old four-call limit when the user raises it", async provider => {
  let count = 0;
  const transport = jest.fn(async () => response(provider, ++count === 6));
  expect(await run(provider, 6, transport)).toMatchObject({ text: "Готово", requests: 6 });
  expect(transport).toHaveBeenCalledTimes(6);
});
test.each(protocols)("%s rejects invalid limits before spending a request", async provider => {
  const transport = jest.fn();
  await expect(run(provider, 0, transport)).rejects.toThrow("от 1 до 20");
  await expect(run(provider, 21, transport)).rejects.toThrow("от 1 до 20");
  expect(transport).not.toHaveBeenCalled();
});
