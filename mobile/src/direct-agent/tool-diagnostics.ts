/** Provider-neutral boundary: approved Inbox excerpts must never be serialized into
 * diagnostic files, even when optional content logging is enabled.
 * The LLM tool response itself is unchanged; only the diagnostic copy is removed.
 */
export function diagnosticToolResultContent(
  toolName: string, result: Record<string, unknown>,
): Record<string, string> | undefined {
  if (toolName === "list_inbox_for_triage") return undefined;
  return { result: JSON.stringify(result) };
}
