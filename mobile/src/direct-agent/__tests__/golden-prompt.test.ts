import { systemPrompt } from "../engine";
import { system } from "../compatible";
import { DEFAULT_SECTIONS } from "../fact-tool";
import type { MemorySection } from "../fact-tool";
import type { ConversationContext } from "../conversation-context";

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
  // Bootstrap exact snapshots from the real compiled Jest environment, then
  // commit the immutable snapshot and replace this temporary capture.
  const serialized = JSON.stringify(actual);
  const size = 3500;
  for (let offset = 0, part = 0; offset < serialized.length; offset += size, part++)
    console.log("ARCH0_PROMPTS_PART_" + part + ":" + serialized.slice(offset, offset + size));
});
