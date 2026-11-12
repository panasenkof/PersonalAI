import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentOptions } from "../engine";
import type { ChatArticlePage } from "../conversations";
import { DEFAULT_SECTIONS } from "../fact-tool";

/** ARCH-0: the source of truth is the CURRENT shared registry, not a duplicate
 * catalog mock. Preserve name/order, all descriptions and every JSON schema.
 */
const settings: DirectAgentOptions["settings"] = {
  provider: "openai", model: "golden-test-model",
  baseUrl: "https://api.openai.com/v1", apiKey: "local-fixture-only",
  webSearchKey: "", allowWeb: false,
};
const base = (): DirectAgentOptions => ({
  settings, prompt: "Проверь мои заметки", history: [],
  lookup: jest.fn().mockResolvedValue([]), propose: jest.fn(),
});
const article: ChatArticlePage = {
  kind: "saved_ai_links", savedFrom: "2026-11-01T00:00:00.000Z",
  savedBefore: "2026-11-08T00:00:00.000Z",
  startLocal: "2026-11-01", endLocal: "2026-11-07",
  nextCursor: { beforeCreatedAt: "2026-11-03T12:00:00.000Z", beforeId: "article-1" },
  selected: [{ id: "article-1", version: 1 }],
};
const full = (): DirectAgentOptions => ({
  ...base(), sections: DEFAULT_SECTIONS,
  read: jest.fn(), searchSources: jest.fn(), listSources: jest.fn(),
  readSource: jest.fn(), list: jest.fn(), count: jest.fn(),
  selectArticles: jest.fn(), searchPhotos: jest.fn(),
  previewMove: jest.fn(), previewSectionAction: jest.fn(),
  saveWorkspace: jest.fn(), workspaceAvailable: jest.fn(() => true),
  contextClassificationEnabled: true, photoQueryAvailable: true,
  articleContinuation: article, articleSelection: article,
});
const modes: Array<{ name: string; options: () => DirectAgentOptions }> = [
  { name: "minimum", options: base },
  { name: "all-available-tools", options: full },
  { name: "context-only", options: () => ({
    ...base(), contextOnly: true, contextClassificationEnabled: true,
  }) },
  { name: "context-only-with-import-tags", options: () => ({
    ...base(), contextOnly: true, contextClassificationEnabled: true,
    importTagsEnabled: true,
  }) },
];

test("ARCH-0: complete registry definitions in four configurations", () => {
  const actual = modes.map(({ name, options }) => ({
    name,
    // This is the entire advertised array including actual descriptions,
    // property types, required keys and their order. Do not filter or sort.
    definitions: createToolCatalog(options(), [], [], []).definitions,
  }));
  expect(actual).toHaveLength(4);
  expect(actual[0].definitions).toHaveLength(3);
  expect(actual[2].definitions.map(d => d.name)).toEqual(["set_conversation_context"]);
  expect(actual[3].definitions.map(d => d.name)).toEqual(["propose_import_metadata"]);
  // One-time snapshot capture from the test runtime; afterwards replace with
  // toMatchSnapshot() and commit the generated exact serialized artifact.
  const serialized = JSON.stringify(actual);
  const size = 3500;
  for (let offset = 0, part = 0; offset < serialized.length; offset += size, part++)
    console.log("ARCH0_TOOLS_PART_" + part + ":" + serialized.slice(offset, offset + size));
});

test("ARCH-0: complete tool names and their order are readable without a snapshot diff", () => {
  const names = createToolCatalog(full(), [], [], []).definitions.map(d => d.name);
  expect(names).toEqual([
    "set_conversation_context",
    "search_local_notes",
    "search_local_photos",
    "read_local_note",
    "search_local_source_segments",
    "list_local_sources",
    "read_local_source_segment",
    "list_local_notes",
    "count_local_notes",
    "select_local_articles",
    "continue_local_articles",
    "read_selected_local_articles",
    "read_selected_article_chunk",
    "selected_article_read_coverage",
    "propose_move_local_note",
    "propose_create_memory_section",
    "propose_delete_memory_section",
    "draft_memory_fact",
    "update_task_state",
    "workspace_put",
    "workspace_list",
    "workspace_get",
    "workspace_clear",
  ]);
});
