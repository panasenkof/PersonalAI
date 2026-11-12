export const queryParameters = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
export const text = (v: unknown, cap = 600) => typeof v === "string" ? v.slice(0, cap) : "";
const SECTION_TOOL_ERRORS = new Set([
  "application_locked","invalid_section_action_args","section_parent_unavailable",
  "section_parent_changed","section_sibling_name_exists","section_delete_protected_or_missing",
  "section_has_children","section_not_empty","collection_not_empty","collection_delete_protected",
  "stale_collection",
]);
export const sectionToolError = (error:unknown) => {
  const code=error instanceof Error ? error.message : "";
  return SECTION_TOOL_ERRORS.has(code) ? code : "section_action_unavailable";
};
