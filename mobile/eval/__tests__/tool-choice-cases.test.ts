import * as fs from "node:fs";
import * as path from "node:path";
import {TOOL_CHOICE_CASES} from "../tool-choice-cases";

test("ARCH-11 corpus: 15 distinct blind tool-selection tasks with the required groups", () => {
  expect(TOOL_CHOICE_CASES).toHaveLength(15);
  expect(new Set(TOOL_CHOICE_CASES.map(c => c.id)).size).toBe(15);
  expect(new Set(TOOL_CHOICE_CASES.map(c => c.group))).toEqual(new Set([
    "memory", "articles", "photos", "proposals", "dialogue",
    "workspace", "general", "unavailable",
  ]));
  expect(TOOL_CHOICE_CASES.filter(c => c.firstTool === null)).toHaveLength(2);
  for (const c of TOOL_CHOICE_CASES) {
    expect(c.prompt.length).toBeGreaterThan(35);
    expect(c.prompt).toMatch(/[а-яё]/i);
    expect(c.prompt).not.toContain("PRIVATE_RECORD_");
    expect(c.forbidden).not.toContain(c.firstTool);
    expect(c.forbidden).toContain("send_email");
    expect(c.id).toMatch(/^T\d\d-/);
  }
});

test("ARCH-11 suite covers all required first-tool decisions without exposing expected calls to prompts", () => {
  expect(TOOL_CHOICE_CASES.map(c => c.firstTool).filter(Boolean)).toEqual([
    "search_local_notes", "read_local_note", "count_local_notes",
    "select_local_articles", "continue_local_articles",
    "read_selected_local_articles", "search_local_photos",
    "propose_move_local_note", "propose_create_memory_section",
    "propose_delete_memory_section", "draft_memory_fact",
    "set_conversation_context", "workspace_put",
  ]);
  for (const c of TOOL_CHOICE_CASES) {
    expect(c.prompt).not.toContain(c.firstTool || "no_tool");
  }
});


test("ARCH-11 workflow isolates each provider's API key and model configuration", () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, "../../../.github/workflows/arch3-tool-choice.yml"), "utf8");
  const keyLine = workflow.split("\n").find(line => line.trim().startsWith("PERSAI_ARCH3_API_KEY:"));
  const modelLine = workflow.split("\n").find(line => line.trim().startsWith("PERSAI_ARCH3_MODEL:"));
  expect(keyLine).toBeDefined();
  expect(modelLine).toBeDefined();
  // Indexing the secrets context by provider-selected NAME fails closed when a
  // provider key is absent; the old && secret-value || generic-key leaked keys
  // across providers because GitHub expressions treat empty secrets as false.
  expect(keyLine).toContain("secrets[inputs.provider");
  expect(keyLine).toContain("'PERSAI_ARCH3_OPENAI_API_KEY'");
  expect(keyLine).toContain("'PERSAI_ARCH3_ANTHROPIC_API_KEY'");
  expect(keyLine).toContain("'PERSAI_EVAL_LLM_API_KEY'");
  expect(keyLine).not.toMatch(/&&\s*secrets\./);
  expect(modelLine).toContain("vars[inputs.provider");
  expect(modelLine).not.toMatch(/&&\s*vars\./);
});
