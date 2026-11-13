/** ARCH-3c2: test the outbound provider wire payload, not only a pure
 * prompt builder. All LLM responses below are synthetic; not live eval. */
import { runDirectAgent, type DirectAgentOptions } from "../engine";

type Provider = DirectAgentOptions["settings"]["provider"];

const base = (provider: Provider, extra: Partial<DirectAgentOptions> = {}): DirectAgentOptions => ({
  settings: {
    provider, model: "fixture-model", apiKey: "synthetic-key",
    baseUrl: provider === "anthropic" ? "https://api.anthropic.com/v1"
      : provider === "openai" ? "https://api.openai.com/v1" : "https://api.deepseek.com/v1",
    webSearchKey: "", allowWeb: false,
  },
  prompt: "Найди мои заметки", history: [],
  sections: [{ slug: "notes", name: "Заметки" }],
  contextClassificationEnabled: true,
  lookup: jest.fn().mockResolvedValue([]),
  propose: jest.fn(),
  ...extra,
});

async function request(provider: Provider, extra: Partial<DirectAgentOptions> = {},
  settingsExtra: Partial<DirectAgentOptions["settings"]> = {}) {
  const outbound: Array<Record<string, any>> = [];
  const diagnostic = jest.fn();
  const result = provider === "openai"
    ? { status: "completed", output: [{
      type: "message", content: [{ type: "output_text", text: "Готово" }],
    }] }
    : provider === "anthropic"
      ? { content: [{ type: "text", text: "Готово" }], stop_reason: "end_turn" }
      : { choices: [{ message: { role: "assistant", content: "Готово" }, finish_reason: "stop" }] };
  const transport = jest.fn(async (_url: unknown, init: any) => {
    outbound.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => result };
  });
  const options = base(provider, extra);
  options.settings = { ...options.settings, ...settingsExtra };
  const response = await runDirectAgent({
    ...options, transport: transport as unknown as typeof fetch, diagnostic,
  });
  expect(response.text).toBe("Готово");
  expect(outbound).toHaveLength(1);
  const body = outbound[0];
  const system = provider === "openai" ? body.input[0].content :
    provider === "anthropic" ? body.system : body.messages[0].content;
  expect(typeof system).toBe("string");
  expect(diagnostic).toHaveBeenCalledWith("agent.prompt", { chars: system.length });
  return { body, system: system as string };
}

test("ARCH-3c2: Responses, chat-compatible and Anthropic send IDENTICAL instructions for identical tools", async () => {
  const common: Partial<DirectAgentOptions> = {
    context: { topic: "Личные заметки", sectionSlug: "notes", pinned: true },
    read: jest.fn(), list: jest.fn(), count: jest.fn(),
    searchSources: jest.fn(), listSources: jest.fn(), readSource: jest.fn(),
    previewMove: jest.fn(), previewSectionAction: jest.fn(),
    selectArticles: jest.fn(), searchPhotos: jest.fn(), photoQueryAvailable: true,
    workspaceAvailable: jest.fn(() => true), saveWorkspace: jest.fn(),
  };
  const responses = await request("openai", common);
  const compatible = await request("openai-compatible", common);
  const anthropic = await request("anthropic", common);
  expect(responses.system).toBe(compatible.system);
  expect(compatible.system).toBe(anthropic.system);
  expect(responses.system).toContain("selected_article_read_coverage");
  expect(responses.system).toContain("раздел закреплён пользователем");
  for (const item of [responses, compatible, anthropic]) {
    const tools = item.body.tools;
    expect(tools).toHaveLength(23);
  }
});

test.each(["openai", "openai-compatible", "anthropic"] as const)(
  "ARCH-3c2: %s only mentions present tools in normal and restricted calls", async provider => {
    const ordinary = await request(provider);
    expect(ordinary.system).toContain("search_local_notes");
    for (const absent of [
      "search_local_photos", "read_selected_local_articles", "read_web_page",
      "propose_move_local_note", "workspace_put", "web_search",
    ]) expect(ordinary.system).not.toContain(absent);

    const contextOnly = await request(provider, { contextOnly: true });
    expect(contextOnly.system).toContain("set_conversation_context");
    expect(contextOnly.system).not.toContain("search_local_notes");
    expect(contextOnly.system).not.toContain("read_selected_local_articles");
    expect(contextOnly.system).not.toContain("draft_memory_fact");
    expect(contextOnly.body.tools).toHaveLength(1);

    const importTags = await request(provider, { contextOnly: true, importTagsEnabled: true });
    expect(importTags.system).toContain("propose_import_metadata");
    expect(importTags.system).not.toContain("search_local_notes");
    expect(importTags.system).not.toContain("set_conversation_context");
    expect(importTags.body.tools).toHaveLength(1);
  },
);

test("ARCH-3c2: built-in native web_search is both advertised and described only when allowed", async () => {
  const allowed = await request("openai", { prompt: "Поищи в интернете новости технологий" },
    { allowWeb: true, searchProvider: "builtin" });
  expect(allowed.body.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "web_search" }),
  ]));
  expect(allowed.system).toContain("web_search");
  const blocked = await request("openai", { prompt: "Найди мои заметки" });
  expect(blocked.body.tools.some((t: any) => t.type === "web_search")).toBe(false);
  expect(blocked.system).not.toContain("web_search");
});
