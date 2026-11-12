import { systemPrompt } from "../engine";
import { system } from "../compatible";
import { DEFAULT_SECTIONS } from "../fact-tool";
import type { MemorySection } from "../fact-tool";
import type { ConversationContext } from "../conversation-context";

// Snapshot the complete serialized values in stable JSON, without Jest's
// noisy object-wrapper formatting. No prompts, names, descriptions or schemas
// are normalized: one changed character fails the golden snapshot.
expect.addSnapshotSerializer({
  test: (value: unknown) => Boolean(value && typeof value === "object" &&
    (value as { __arch0Snapshot?: boolean }).__arch0Snapshot === true),
  print: (value: unknown) => JSON.stringify(
    (value as { actual: unknown }).actual, null, 2),
});

/** ARCH-0: capture the EXACT prompt bytes for both existing LLM protocols.
 * Do not normalize whitespace or strip rules: ARCH-1 must preserve all text.
 */
const dialogue: ConversationContext = { topic: "Тест", sectionSlug: "notes", pinned: false };
const variants: Array<{
  name: string; sections?: MemorySection[]; context?: ConversationContext; enabled?: boolean;
}> = [
  { name: "default" },
  { name: "sections-and-context-enabled", sections: DEFAULT_SECTIONS, enabled: true },
  { name: "context-unpinned", sections: DEFAULT_SECTIONS, context: dialogue, enabled: true },
  { name: "context-pinned", sections: DEFAULT_SECTIONS,
    context: { ...dialogue, pinned: true }, enabled: true },
];

test("ARCH-0: exact system prompts for Responses and compatible protocols (four contexts)", () => {
  const actual = variants.map(({ name, sections, context, enabled }) => ({
    name,
    responses: systemPrompt(sections, context, enabled),
    compatible: system(sections, context, enabled),
  }));
  expect(actual).toHaveLength(4);
  expect(actual[2].responses).toContain("Текущая тема диалога");
  expect(actual[3].responses).toContain("раздел закреплён пользователем");
  expect(actual[3].compatible).toContain("закреплён пользователем");
  expect({ __arch0Snapshot: true, actual }).toMatchSnapshot();
});
